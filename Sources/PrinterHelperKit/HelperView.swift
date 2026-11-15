import AppKit

@MainActor
public final class HelperView: NSStackView {
    public var onEnable: (() -> Void)?
    public var onApprove: (() -> Void)?
    public var onCancel: (() -> Void)?
    public var onAcknowledge: (() -> Void)?
    private let status = NSTextField(wrappingLabelWithString: "")
    private let details = NSTextField(wrappingLabelWithString: "")
    private let image = NSImageView()
    private let enable = NSButton(title: "Enable Bluetooth", target: nil, action: nil)
    private let approve = NSButton(title: "Approve this one print", target: nil, action: nil)
    private let cancel = NSButton(title: "Cancel job", target: nil, action: nil)
    private let acknowledge = NSButton(title: "Acknowledge shown uncertain outcome", target: nil, action: nil)

    public override init(frame: NSRect) {
        super.init(frame: frame)
        appearance = NSAppearance(named: .aqua)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        let heading = NSTextField(labelWithString: "Pocket Printer Helper")
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        let scope = NSTextField(wrappingLabelWithString: "This app can print and feed paper. Each MCP job needs your explicit approval here. No automatic retries. Keep this window open.")
        for (button, action) in [(enable, #selector(enableBluetooth)), (approve, #selector(approveJob)),
                                 (cancel, #selector(cancelJob)), (acknowledge, #selector(acknowledgeOutcome))] {
            button.target = self; button.action = action; button.bezelStyle = .rounded
        }
        let buttons = NSStackView(views: [enable, approve, cancel])
        buttons.spacing = 8
        image.imageScaling = .scaleProportionallyDown
        orientation = .vertical; alignment = .leading; spacing = 16
        edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        for view in [heading, scope, buttons, status, details, acknowledge, image] { addArrangedSubview(view) }
        image.heightAnchor.constraint(greaterThanOrEqualToConstant: 250).isActive = true
        for view in [scope, status, details, image] {
            view.widthAnchor.constraint(equalTo: widthAnchor, constant: -48).isActive = true
        }
        render(bluetooth: "not_requested", active: nil, latest: nil, preview: nil, blocked: false, fatal: nil)
    }
    required init?(coder: NSCoder) { nil }

    public func showIPCError(_ code: String) {
        status.stringValue = "IPC: \(code). Query the stable job ID; never automatically retry."
    }

    public func render(bluetooth: String, active: JobReceipt?, latest: JobReceipt?, preview: Data?, blocked: Bool, fatal: String?,
                       canAcknowledge: Bool = false, acknowledgmentUnavailableReason: String? = nil) {
        status.stringValue = fatal.map { "Helper unavailable: \($0)" } ?? "Bluetooth: \(bluetooth). IPC accepts only this user."
        enable.isEnabled = fatal == nil && ["not_requested", "startup_timeout"].contains(bluetooth)
        approve.isEnabled = active?.state == "awaiting_approval" && bluetooth == "ready" && !blocked && fatal == nil
        cancel.isEnabled = active != nil
        acknowledge.isHidden = !blocked || fatal != nil
        acknowledge.isEnabled = canAcknowledge
        image.image = preview.flatMap { NSImage(data: $0) }
        if let receipt = active ?? latest {
            let length = Double(receipt.height + 80) / 203 * 25.4
            details.stringValue = "Job: \(receipt.job_id)\nDevice: \(receipt.device_id)\nImage SHA-256: \(receipt.image_sha256)\n384 x \(receipt.height), plus 80 clearance dots (~\(Int(length.rounded())) mm total).\n\(receipt.state): \(receipt.message)\nPaper is never confirmed by queue submission. Inspect the output before any new approval."
            if let acknowledgmentUnavailableReason { details.stringValue += "\n" + acknowledgmentUnavailableReason }
        } else {
            details.stringValue = "No print job. Enable Bluetooth only if the macOS prompt names Pocket Printer Helper. A development rebuild may request approval again. Waiting for an explicit MCP submission; no file paths or raw BLE commands accepted."
        }
    }
    @objc private func enableBluetooth() { onEnable?() }
    @objc private func approveJob() { onApprove?() }
    @objc private func cancelJob() { onCancel?() }
    @objc private func acknowledgeOutcome() { onAcknowledge?() }
}
