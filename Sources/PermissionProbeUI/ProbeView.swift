import AppKit
import PermissionProbeCore

@MainActor
public final class ProbeView: NSView {
    public let scanButton = NSButton(title: "Scan nearby printers", target: nil, action: nil)
    public let cancelButton = NSButton(title: "Cancel scan", target: nil, action: nil)
    private let status = NSTextField(wrappingLabelWithString: "")
    private let permission = NSTextField(wrappingLabelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let results = NSTextView()
    public var onScan: (() -> Void)?
    public var onCancel: (() -> Void)?

    public override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        let heading = NSTextField(labelWithString: "Pocket Printer Probe")
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        let scope = NSTextField(wrappingLabelWithString: "Permission feasibility gate. Discovery only: no connection, query, feed or print.")
        scope.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 15, weight: .semibold)
        detail.font = .systemFont(ofSize: 13)
        scanButton.bezelStyle = .rounded
        cancelButton.bezelStyle = .rounded
        scanButton.target = self
        scanButton.action = #selector(scanPressed)
        cancelButton.target = self
        cancelButton.action = #selector(cancelPressed)
        let buttons = NSStackView(views: [scanButton, cancelButton])
        buttons.orientation = .horizontal
        buttons.spacing = 12
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        results.isEditable = false
        results.isSelectable = true
        results.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        results.textContainerInset = NSSize(width: 8, height: 8)
        results.isHorizontallyResizable = false
        results.isVerticallyResizable = true
        results.autoresizingMask = [.width]
        results.textContainer?.widthTracksTextView = true
        scroll.documentView = results
        let footer = NSTextField(wrappingLabelWithString: "Expected native prompt name: Pocket Printer Probe. If macOS names another app, stop. A successful scan does not prove stable permission across rebuilds.")
        footer.font = .systemFont(ofSize: 12)
        footer.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [heading, scope, buttons, permission, status, detail, scroll, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -24),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 170)
        ])
        for view in [scope, permission, status, detail, scroll, footer] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        update(phase: .idle, permission: .notDetermined, devices: [], limited: false)
    }

    required init?(coder: NSCoder) { nil }

    public func update(phase: ProbePhase, permission: ProbePermission, devices: [ProbeDevice], limited: Bool) {
        self.permission.stringValue = phase == .idle ? "Permission: Not checked (press Scan)" : "Permission: \(permission.rawValue)"
        status.stringValue = phase.title
        detail.stringValue = phase.detail
        scanButton.isEnabled = !phase.isActive && phase != .closed
        cancelButton.isEnabled = phase.isActive
        var text = devices.isEmpty ? "No printer advertisements recorded." : devices.map {
            "\($0.name)\n\($0.id.uuidString)  RSSI \($0.rssi) dBm"
        }.joined(separator: "\n\n")
        if limited { text += "\n\nResult limit reached (32). Additional devices omitted." }
        results.string = text
    }

    @objc private func scanPressed() { onScan?() }
    @objc private func cancelPressed() { onCancel?() }
}
