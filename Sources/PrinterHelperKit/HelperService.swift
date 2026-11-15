import CryptoKit
import CoreGraphics
import Foundation
import PrinterCLIKit

@MainActor
public final class HelperService {
    public typealias Executor = @MainActor (PrintJob, UUID) async throws -> String
    public var onChange: (@MainActor () -> Void)?
    public private(set) var active: JobReceipt?
    public private(set) var preview: Data?
    public private(set) var latest: JobReceipt?
    public private(set) var safetyBlocked = false
    public private(set) var unresolved: [JobReceipt] = []
    public private(set) var restartRequired = false
    private var storageBlocked = false
    private let store: ReceiptStore
    private let instance = UUID()
    private let bluetooth: @MainActor () -> String
    private let execute: Executor
    private var job: PrintJob?
    private var work: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private var closed = false
    public var canAcknowledge: Bool { !closed && !restartRequired && !storageBlocked && active == nil && !unresolved.isEmpty }
    public var acknowledgmentUnavailableReason: String? {
        if storageBlocked { return "Storage failure: acknowledgment is unavailable; do not delete receipts or retry printing." }
        if restartRequired { return "Quit and restart before acknowledging this uncertain outcome." }
        return nil
    }

    public init(store: ReceiptStore, bluetooth: @escaping @MainActor () -> String, execute: @escaping Executor) throws {
        self.store = store; self.bluetooth = bluetooth; self.execute = execute
        for var receipt in try store.all() {
            if receipt.state == "awaiting_approval" {
                receipt.state = "cancelled_before_submission"
                receipt.error_code = "helper_restarted"
                receipt.message = "Helper restarted before durable approval. No print was submitted; this ID will never replay."
                receipt.updated_at = Date()
                try store.save(receipt)
            } else if ["in_progress", "cancelling"].contains(receipt.state) {
                receipt.state = "uncertain"
                receipt.error_code = "helper_restarted"
                receipt.message = "Helper ended after durable approval. Paper outcome is unknown; no replay. Inspect it before acknowledging here."
                receipt.updated_at = Date()
                try store.save(receipt)
            }
            if receipt.state == "uncertain", receipt.outcome_acknowledged != true { unresolved.append(receipt) }
        }
        safetyBlocked = !unresolved.isEmpty
        latest = unresolved.first
    }

    public func handle(_ data: Data) -> HelperReply {
        var id: UUID?
        do {
            let request = try HelperRequest.decode(data)
            id = request.request_id
            guard !closed else { throw HelperFailure("helper_closing", "Helper is closing; no new operation accepted.") }
            let result: HelperResult
            switch request.method {
            case "helper_status":
                result = HelperResult(health: HelperHealth(bluetooth: bluetooth(), active_job_id: active?.job_id,
                    safety_blocked: safetyBlocked, unresolved_job_ids: unresolved.map(\.job_id),
                    message: safetyBlocked ? "Printing blocked. Inspect unresolved receipts and paper; acknowledge only in the helper window after restart if required." :
                        "No BLE access by this status call. Print needs per-job approval in the helper window."))
            case "inspect_png":
                let (preview, image, _) = try inspect(request.png_base64)
                result = HelperResult(image: image, preview_png_base64: preview.base64EncodedString())
            case "submit_png":
                result = HelperResult(receipt: try admit(request))
            case "job_status", "cancel_job":
                guard let jobID = request.job_id else { throw HelperFailure("invalid_request", "job_id is required.") }
                if request.method == "cancel_job", active?.job_id == jobID { cancelActive() }
                guard let receipt = try receipt(jobID) else { throw HelperFailure("job_not_found", "No receipt for this ID. Do not infer that a different ID is safe to submit.") }
                result = HelperResult(receipt: receipt)
            default: throw HelperFailure("unknown_method", "Unsupported method.")
            }
            return HelperReply(id: id, result: result)
        } catch let failure as HelperFailure {
            if ["receipt_storage_failed", "unsafe_permissions"].contains(failure.code) { safetyBlocked = true; storageBlocked = true; onChange?() }
            return HelperReply(id: id, error: failure)
        } catch let failure as CLIError {
            return HelperReply(id: id, error: HelperFailure(failure.code, failure.localizedDescription))
        } catch {
            safetyBlocked = true
            storageBlocked = true
            onChange?()
            return HelperReply(id: id, error: HelperFailure("receipt_storage_failed", "Local storage failed. No automatic retry; inspect the helper."))
        }
    }

    private func inspect(_ encoded: String?) throws -> (Data, ImageInspection, PrintJob) {
        guard let encoded, encoded.utf8.count <= ((HelperLimits.pngBytes + 2) / 3) * 4,
              let data = Data(base64Encoded: encoded), data.count <= HelperLimits.pngBytes else {
            throw HelperFailure("invalid_image", "Expected strict base64 PNG bytes, at most 1 MiB decoded.")
        }
        let bitmap = try RasterImage.decodePNG(data)
        let job = try PrintJob.image(bitmap)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        // Explicit pixels avoid decode-array and one-bit representation differences in PNG/AppKit.
        var pixels = [UInt8](repeating: 255, count: bitmap.width * bitmap.height)
        for index in pixels.indices {
            if bitmap.bytes[index / 8] & (0x80 >> (index % 8)) != 0 { pixels[index] = 0 }
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else {
            throw HelperFailure("preview_failed", "Cannot construct print preview pixels.")
        }
        let image = CGImage(width: bitmap.width, height: bitmap.height, bitsPerComponent: 8, bitsPerPixel: 8,
                            bytesPerRow: bitmap.width, space: CGColorSpaceCreateDeviceGray(),
                            bitmapInfo: CGBitmapInfo(rawValue: 0), provider: provider,
                            decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        guard let image else {
            throw HelperFailure("preview_failed", "Cannot construct the exact monochrome print preview.")
        }
        let preview = try RasterImage.pngData(for: image)
        return (preview, ImageInspection(sha256: digest, width: bitmap.width, height: bitmap.height,
                                     png_bytes: data.count, raster_bands: job.rasterBands, clearance_dots: job.feedDots), job)
    }

    private func admit(_ request: HelperRequest) throws -> JobReceipt {
        guard request.paper_approved == true else {
            throw HelperFailure("paper_approval_required", "Obtain explicit approval for this one job before setting paper_approved. Native per-job approval is also required.")
        }
        guard let id = request.job_id, let device = request.device_id else {
            throw HelperFailure("invalid_request", "Stable job_id and explicit device_id UUIDs are required.")
        }
        let (data, image, prepared) = try inspect(request.png_base64)
        if let previous = try receipt(id) {
            guard previous.image_sha256 == image.sha256, previous.device_id == device else {
                throw HelperFailure("job_id_conflict", "This ID already identifies a different payload or device. Nothing was resubmitted.")
            }
            return previous
        }
        guard !safetyBlocked else { throw HelperFailure("safety_blocked", "Uncertain transfer or storage error. Quit and inspect receipts before considering another explicitly approved job.") }
        guard active == nil else { throw HelperFailure("busy", "One job is already admitted. Nothing was queued.") }
        guard bluetooth() == "ready" else {
            throw HelperFailure("bluetooth_\(bluetooth())", "Bluetooth is not ready. Use the helper's explicit permission button and observe macOS; nothing was admitted.")
        }
        let now = Date()
        let receipt = JobReceipt(job_id: id, device_id: device, image_sha256: image.sha256, height: image.height,
            instance_id: instance, state: "awaiting_approval",
            message: "Durably admitted, not sent. Review and approve exactly this job in the helper window within five minutes.",
            created_at: now, updated_at: now)
        // The write-ahead receipt survives process loss. Image bytes are memory-only.
        try store.save(receipt, new: true)
        active = receipt; latest = receipt; job = prepared; preview = data
        expiry = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 300_000_000_000) } catch { return }
            guard let self, self.active?.job_id == id, self.active?.state == "awaiting_approval" else { return }
            self.cancelActive(reason: "Approval expired. No bytes submitted.")
        }
        onChange?()
        return receipt
    }

    public func receipt(_ id: UUID) throws -> JobReceipt? {
        if active?.job_id == id { return active }
        if latest?.job_id == id { return latest }
        return try store.read(id)
    }

    public func approveActive() {
        guard !closed, !safetyBlocked, var receipt = active, receipt.state == "awaiting_approval", let job else { return }
        guard bluetooth() == "ready" else { cancelActive(reason: "Bluetooth is no longer ready. No print started."); return }
        expiry?.cancel(); expiry = nil
        receipt.state = "in_progress"; receipt.message = "Native user approved this one job. Outcome is not yet known."; receipt.updated_at = Date()
        guard persist(receipt) else { return }
        active = receipt; latest = receipt
        work = Task { [weak self, execute] in
            do {
                let message = try await execute(job, receipt.device_id)
                try Task.checkCancellation()
                self?.finish(state: "submitted_only", message: message, code: nil)
            } catch let error as CLIError {
                self?.finish(state: "uncertain", message: error.localizedDescription, code: error.code)
            } catch is CancellationError {
                self?.finish(state: "uncertain", message: "Cancellation stopped remaining work, not bytes already submitted. Inspect paper; no replay.", code: "cancelled")
            } catch {
                self?.finish(state: "uncertain", message: "Unexpected native failure. Paper outcome unknown; no retry.", code: "native_failure")
            }
        }
        onChange?()
    }

    public func cancelActive(reason: String = "Cancelled before native approval. No bytes submitted.") {
        guard var receipt = active else { return }
        expiry?.cancel(); expiry = nil
        if receipt.state == "awaiting_approval" {
            finish(state: "cancelled_before_submission", message: reason, code: nil)
        } else {
            receipt.state = "cancelling"
            receipt.message = "Cancellation requested. Already submitted bytes cannot be undone."
            receipt.updated_at = Date()
            guard persist(receipt) else { return }
            active = receipt; latest = receipt
            safetyBlocked = true
            work?.cancel()
            onChange?()
        }
    }

    public func close() { closed = true; cancelActive(reason: "Helper closed before approval. No bytes submitted.") }

    public func acknowledgeUncertainty() {
        guard !closed, !restartRequired, !storageBlocked, active == nil, var receipt = unresolved.first else { return }
        receipt.outcome_acknowledged = true
        receipt.updated_at = Date()
        receipt.message += " User acknowledged the uncertain outcome in the helper window; this is not paper confirmation."
        guard persist(receipt) else { return }
        unresolved.removeFirst()
        safetyBlocked = !unresolved.isEmpty
        latest = unresolved.first ?? receipt
        onChange?()
    }

    private func persist(_ receipt: JobReceipt) -> Bool {
        do { try store.save(receipt); return true } catch {
            safetyBlocked = true
            storageBlocked = true
            var uncertain = receipt
            uncertain.state = "uncertain"; uncertain.error_code = "receipt_storage_failed"
            uncertain.message = "Receipt update failed. Printing is blocked; consult the durable admission record. Never resubmit automatically."
            active = nil; latest = uncertain; preview = nil; job = nil
            work?.cancel()
            onChange?()
            return false
        }
    }

    private func finish(state: String, message: String, code: String?) {
        guard var receipt = active else { return }
        receipt.state = state; receipt.message = message; receipt.error_code = code; receipt.updated_at = Date()
        if state == "uncertain" {
            safetyBlocked = true
            restartRequired = true
            unresolved.append(receipt)
        }
        guard persist(receipt) else { return }
        latest = receipt; active = nil; preview = nil; job = nil; work = nil
        onChange?()
    }
}
