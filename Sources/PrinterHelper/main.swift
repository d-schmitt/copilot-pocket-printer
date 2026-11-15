import AppKit
import PrinterCLIKit
import PrinterHelperKit

@MainActor
final class HelperDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let authorization = HelperAuthorization()
    private var service: HelperService?
    private var server: UnixServer?
    private var window: NSWindow?
    private let view = HelperView(frame: NSRect(x: 0, y: 0, width: 760, height: 900))
    private var fatal: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        view.onEnable = { [weak self] in self?.authorization.request() }
        view.onApprove = { [weak self] in self?.service?.approveActive() }
        view.onCancel = { [weak self] in self?.service?.cancelActive() }
        view.onAcknowledge = { [weak self] in self?.service?.acknowledgeUncertainty() }
        view.onConfirmationMode = { [weak self] mode in self?.service?.setConfirmationMode(mode) }
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Pocket Printer Helper"
        window.contentView = view; window.minSize = NSSize(width: 760, height: 860)
        window.isReleasedWhenClosed = false; window.delegate = self
        self.window = window
        authorization.changed = { [weak self] in self?.refresh() }
        do {
            let store = try ReceiptStore(directory: HelperPaths.receiptDirectory)
            let service = try HelperService(store: store, bluetooth: { [weak self] in self?.authorization.state ?? "unavailable" }) { job, device in
                let client = try PrinterClient.native(timeout: 8)
                return try await client.submit(job, deviceID: device)
            }
            self.service = service
            service.onChange = { [weak self] in self?.refresh() }
            let server = try UnixServer(directory: HelperPaths.socketDirectory, onError: { [weak self] code in
                Task { @MainActor in self?.view.showIPCError(code) }
            }, handler: { [weak service] data in
                service?.handle(data) ?? HelperReply(id: nil, error: HelperFailure("helper_closing", "Helper closed."))
            })
            self.server = server; server.start()
        } catch {
            fatal = error.localizedDescription
        }
        refresh(); window.center(); window.makeKeyAndOrderFront(nil)
    }

    private func refresh() {
        view.render(bluetooth: authorization.state, active: service?.active, latest: service?.latest,
                    preview: service?.preview, blocked: service?.safetyBlocked ?? true, fatal: fatal,
                    canAcknowledge: service?.canAcknowledge == true,
                    acknowledgmentUnavailableReason: service?.acknowledgmentUnavailableReason,
                    confirmationMode: service?.confirmationMode ?? .native,
                    confirmationPreferenceError: service?.confirmationPreferenceError)
    }
    func windowWillClose(_ notification: Notification) { stop() }
    func applicationWillTerminate(_ notification: Notification) { stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    private func stop() { server?.stop(); service?.close(); authorization.stop() }
}

@main
enum HelperApplication {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = HelperDelegate()
        app.delegate = delegate
        let menu = NSMenu()
        let item = NSMenuItem()
        let submenu = NSMenu()
        submenu.addItem(withTitle: "Quit Pocket Printer Helper", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = submenu; menu.addItem(item); app.mainMenu = menu
        withExtendedLifetime(delegate) { app.run() }
    }
}
