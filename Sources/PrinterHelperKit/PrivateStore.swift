import Darwin
import Foundation

public enum HelperPaths {
    public static var socketDirectory: URL { URL(fileURLWithPath: "/tmp/cpp-\(getuid())") }
    public static var receiptDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/CopilotPocketPrinter")
    }
}

func privateDirectory(_ url: URL) throws {
    if mkdir(url.path, 0o700) != 0 && errno != EEXIST {
        throw HelperFailure("private_storage_failed", "Cannot create private helper directory.")
    }
    var info = stat()
    guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
          info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
        throw HelperFailure("unsafe_permissions", "Helper directory must be owned by this user, mode 0700, and not a symlink.")
    }
}

func secureOpen(_ path: String, flags: Int32) throws -> Int32 {
    let fd = open(path, flags | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw HelperFailure("receipt_storage_failed", "Cannot open private receipt storage.") }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
          info.st_uid == getuid(), info.st_mode & 0o777 == 0o600, info.st_nlink == 1 else {
        close(fd)
        throw HelperFailure("unsafe_permissions", "Helper storage files must be private regular files, not links.")
    }
    return fd
}

public final class ReceiptStore {
    private let directory: URL
    private let lockFD: Int32
    public init(directory: URL) throws {
        try privateDirectory(directory)
        self.directory = directory
        lockFD = try secureOpen(directory.appendingPathComponent("helper.lock").path, flags: O_RDWR | O_CREAT)
        guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            close(lockFD)
            throw HelperFailure("helper_already_running", "Another helper owns the receipt store. Do not launch another instance.")
        }
    }
    deinit { flock(lockFD, LOCK_UN); close(lockFD) }

    private struct ConfirmationPreference: Codable {
        let confirmation_mode: ConfirmationMode
    }

    public func loadConfirmationMode() throws -> ConfirmationMode {
        do {
            let path = directory.appendingPathComponent("confirmation.json").path
            var info = stat()
            if lstat(path, &info) != 0 {
                guard errno == ENOENT else { throw HelperFailure("preference_read_failed", "Cannot inspect confirmation preference.") }
                return .native
            }
            let fd = try secureOpen(path, flags: O_RDONLY | O_NONBLOCK)
            defer { close(fd) }
            var data = Data(count: 1025)
            let count = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            guard count > 0, count <= 1024 else {
                throw HelperFailure("preference_read_failed", "Confirmation preference is empty, oversized or unreadable.")
            }
            data.count = count
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == ["confirmation_mode"] else {
                throw HelperFailure("preference_parse_failed", "Invalid confirmation preference fields.")
            }
            return try JSONDecoder().decode(ConfirmationPreference.self, from: data).confirmation_mode
        } catch {
            throw HelperFailure("confirmation_preference_read_failed",
                "Cannot load confirmation preference: \(error.localizedDescription) Using native confirmation; save a selection in the helper to repair it.")
        }
    }

    public func saveConfirmationMode(_ mode: ConfirmationMode) throws {
        do {
            let target = directory.appendingPathComponent("confirmation.json")
            var info = stat()
            if lstat(target.path, &info) == 0 {
                let fd = try secureOpen(target.path, flags: O_RDONLY | O_NONBLOCK)
                close(fd)
            } else if errno != ENOENT {
                throw HelperFailure("preference_write_failed", "Cannot inspect confirmation preference.")
            }
            let data = try JSONEncoder().encode(ConfirmationPreference(confirmation_mode: mode))
            try writePrivateData(data, to: target, exclusive: false)
        } catch {
            throw HelperFailure("confirmation_preference_write_failed",
                "Cannot save confirmation preference: \(error.localizedDescription) Using native confirmation for this session; restart may load the last saved mode.")
        }
    }

    public func read(_ id: UUID) throws -> JobReceipt? {
        let path = directory.appendingPathComponent(id.uuidString.lowercased() + ".json").path
        var info = stat()
        if lstat(path, &info) != 0 {
            guard errno == ENOENT else { throw HelperFailure("receipt_storage_failed", "Cannot inspect receipt.") }
            return nil
        }
        let fd = try secureOpen(path, flags: O_RDONLY)
        defer { close(fd) }
        var data = Data(count: 8193)
        let count = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard count > 0, count <= 8192 else { throw HelperFailure("receipt_storage_failed", "Receipt is empty, oversized or unreadable. No replay is permitted.") }
        data.count = count
        guard let receipt = try? HelperJSON.decoder().decode(JobReceipt.self, from: data), receipt.job_id == id else {
            throw HelperFailure("receipt_storage_failed", "Receipt is corrupt. No replay is permitted.")
        }
        return receipt
    }

    public func all() throws -> [JobReceipt] {
        let ids = try receiptIDs()
        guard ids.count <= HelperLimits.receipts else {
            throw HelperFailure("receipt_store_full", "Receipt store exceeds its bound; no new work is permitted.")
        }
        // Only abandoned private temporary writes are disposable, never receipt files.
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path)
        where name.hasPrefix(".") && name.hasSuffix(".tmp") && UUID(uuidString: String(name.dropFirst().dropLast(4))) != nil {
            let path = directory.appendingPathComponent(name).path
            var info = stat()
            if lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
               info.st_mode & 0o777 == 0o600, info.st_nlink == 1, unlink(path) != 0 {
                throw HelperFailure("receipt_storage_failed", "Cannot clean an abandoned private temporary write.")
            }
        }
        return try ids.map { id in
            guard let receipt = try read(id) else {
                throw HelperFailure("receipt_storage_failed", "Missing receipt; no replay is permitted.")
            }
            return receipt
        }.sorted { $0.created_at < $1.created_at }
    }

    private func receiptIDs() throws -> [UUID] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path).compactMap { name in
            guard name.hasSuffix(".json") else { return nil }
            return UUID(uuidString: String(name.dropLast(5)))
        }
    }

    public func save(_ receipt: JobReceipt, new: Bool = false) throws {
        let target = directory.appendingPathComponent(receipt.job_id.uuidString.lowercased() + ".json")
        if new {
            guard try receiptIDs().count < HelperLimits.receipts else {
                throw HelperFailure("receipt_store_full", "Receipt limit reached. Do not clear records or retry with a new ID.")
            }
        }
        let data = try HelperJSON.encoder().encode(receipt)
        guard data.count <= 8192 else { throw HelperFailure("receipt_storage_failed", "Receipt exceeds the storage bound; printing is blocked.") }
        try writePrivateData(data, to: target, exclusive: new)
    }

    private func writePrivateData(_ data: Data, to target: URL, exclusive: Bool) throws {
        let path = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
        let fd = try secureOpen(path.path, flags: O_WRONLY | O_CREAT | O_EXCL)
        var renamed = false
        defer {
            close(fd)
            if !renamed { unlink(path.path) }
        }
        var written = 0
        while written < data.count {
            let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: written), data.count - written) }
            guard count > 0 else { throw HelperFailure("receipt_storage_failed", "Private file write failed.") }
            written += count
        }
        guard fsync(fd) == 0 else { throw HelperFailure("receipt_storage_failed", "Private file sync failed.") }
        // Atomically publish only complete admissions, without overwriting an existing ID.
        let result = exclusive ? renamex_np(path.path, target.path, UInt32(RENAME_EXCL)) : rename(path.path, target.path)
        if result != 0 {
            throw HelperFailure("receipt_storage_failed", "Private file replacement failed.")
        }
        renamed = true
        let directoryFD = open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard directoryFD >= 0 else { throw HelperFailure("receipt_storage_failed", "Cannot open private directory for sync.") }
        defer { close(directoryFD) }
        guard fsync(directoryFD) == 0 else { throw HelperFailure("receipt_storage_failed", "Private directory sync failed.") }
    }
}
