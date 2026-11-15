import Darwin
import Foundation

public final class UnixServer: @unchecked Sendable {
    public let socketPath: String
    private let descriptor: Int32
    private let expectedUID: uid_t
    private let handler: @MainActor (Data) -> HelperReply
    private let slots = DispatchSemaphore(value: 4)
    private let lock = NSLock()
    private var stopped = false
    private let onError: (String) -> Void

    public init(directory: URL, expectedUID: uid_t = getuid(),
                onError: @escaping (String) -> Void,
                handler: @escaping @MainActor (Data) -> HelperReply) throws {
        try privateDirectory(directory)
        socketPath = directory.appendingPathComponent("helper.sock").path
        guard socketPath.utf8.count < 104 else { throw HelperFailure("socket_path_too_long", "Unix socket path is too long.") }
        self.expectedUID = expectedUID; self.handler = handler; self.onError = onError
        var info = stat()
        if lstat(socketPath, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == getuid() else {
                throw HelperFailure("unsafe_socket", "Existing socket path is not an owned socket. Nothing was removed.")
            }
            guard unlink(socketPath) == 0 else { throw HelperFailure("socket_failed", "Cannot remove stale owned socket.") }
        } else if errno != ENOENT { throw HelperFailure("socket_failed", "Cannot inspect socket path.") }
        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw HelperFailure("socket_failed", "Cannot create local socket.") }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: Array(socketPath.utf8) + [0])
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, chmod(socketPath, 0o600) == 0, listen(descriptor, 4) == 0 else {
            close(descriptor)
            throw HelperFailure("socket_failed", "Cannot bind private local socket.")
        }
    }

    public func start() {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            while true {
                lock.lock(); let done = stopped; lock.unlock()
                if done { return }
                let fd = accept(descriptor, nil, nil)
                if fd < 0 {
                    lock.lock(); let done = stopped; lock.unlock()
                    if !done { onError("socket_accept_failed") }
                    return
                }
                var timeout = timeval(tv_sec: 3, tv_usec: 0)
                var yes: Int32 = 1
                guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
                      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
                      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                    close(fd); onError("socket_options_failed"); continue
                }
                guard slots.wait(timeout: .now()) == .success else {
                    do {
                        try Self.send(HelperReply(id: nil, error: HelperFailure("ipc_busy", "Too many local connections.")), fd: fd)
                        Self.finishRejection(fd)
                    }
                    catch { onError("client_disconnected_before_busy_reply") }
                    close(fd); continue
                }
                DispatchQueue.global(qos: .userInitiated).async { [self] in receive(fd) }
            }
        }
    }

    public func stop() {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        stopped = true
        shutdown(descriptor, SHUT_RDWR); close(descriptor)
        if unlink(socketPath) != 0 && errno != ENOENT { onError("socket_cleanup_failed") }
        lock.unlock()
    }

    private func receive(_ fd: Int32) {
        do {
            var uid: uid_t = 0
            var gid: gid_t = 0
            guard getpeereid(fd, &uid, &gid) == 0, uid == expectedUID else {
                throw HelperFailure("wrong_peer", "Local peer user identity does not match the helper user.")
            }
            let deadline = ProcessInfo.processInfo.systemUptime + 3
            let header = try Self.readExactly(4, fd: fd, deadline: deadline)
            let length = header.reduce(0) { ($0 << 8) | Int($1) }
            guard length > 0, length <= HelperLimits.frameBytes else {
                throw HelperFailure("frame_too_large", "Expected a 1...2097152 byte JSON frame.")
            }
            let data = try Self.readExactly(length, fd: fd, deadline: deadline)
            Task { @MainActor [self] in
                let reply = handler(data)
                DispatchQueue.global(qos: .userInitiated).async { [self] in
                    defer { close(fd); slots.signal() }
                    do { try Self.send(reply, fd: fd) } catch { onError("client_disconnected_outcome_must_be_queried") }
                }
            }
        } catch {
            defer { close(fd); slots.signal() }
            let failure = error as? HelperFailure ?? HelperFailure("ipc_failed", "Local IPC failed.")
            do {
                try Self.send(HelperReply(id: nil, error: failure), fd: fd)
                Self.finishRejection(fd)
            } catch { onError("client_disconnected_before_reply") }
        }
    }

    private static func finishRejection(_ fd: Int32) {
        // Closing with unread input can replace the explicit error with ECONNRESET.
        // Half-close the reply, then discard at most one bounded frame for 250ms.
        shutdown(fd, SHUT_WR)
        let deadline = ProcessInfo.processInfo.systemUptime + 0.25
        var discarded = 0
        var bytes = [UInt8](repeating: 0, count: 4096)
        while discarded <= HelperLimits.frameBytes + 4 {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { return }
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&descriptor, 1, Int32(ceil(remaining * 1000))) > 0 else { return }
            let count = recv(fd, &bytes, bytes.count, 0)
            guard count > 0 else { return }
            discarded += count
        }
    }

    private static func readExactly(_ count: Int, fd: Int32, deadline: TimeInterval) throws -> Data {
        var data = Data(count: count)
        var offset = 0
        while offset < count {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { throw HelperFailure("ipc_truncated_or_timeout", "Absolute three-second frame deadline expired.") }
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, Int32(ceil(remaining * 1000)))
            if ready < 0 && errno == EINTR { continue }
            guard ready > 0 else { throw HelperFailure("ipc_truncated_or_timeout", "Absolute three-second frame deadline expired.") }
            let read = data.withUnsafeMutableBytes { recv(fd, $0.baseAddress!.advanced(by: offset), count - offset, 0) }
            if read < 0 && errno == EINTR { continue }
            guard read > 0 else { throw HelperFailure("ipc_truncated_or_timeout", "Incomplete frame or three-second socket deadline; no automatic retry.") }
            offset += read
        }
        return data
    }

    private static func send(_ reply: HelperReply, fd: Int32) throws {
        let payload = try HelperJSON.encoder().encode(reply)
        guard payload.count <= HelperLimits.frameBytes else { throw HelperFailure("response_too_large", "Response exceeds protocol limit.") }
        var size = UInt32(payload.count).bigEndian
        var data = withUnsafeBytes(of: &size) { Data($0) }
        data.append(payload)
        var offset = 0
        while offset < data.count {
            let count = data.withUnsafeBytes { Darwin.send(fd, $0.baseAddress!.advanced(by: offset), data.count - offset, 0) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw HelperFailure("client_disconnected", "Response was not delivered. Consult the stable job ID; do not resubmit.") }
            offset += count
        }
    }
}
