import AppKit
import PermissionProbeCore
import PermissionProbeUI

@MainActor
final class ProbeAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var session: ProbeSession?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let session = ProbeSession(permission: { DiscoveryDriver.permission }, driver: { DiscoveryDriver() },
                                   scheduler: ProbeTimerScheduler())
        self.session = session
        let view = ProbeView(frame: NSRect(x: 0, y: 0, width: 620, height: 580))
        view.onScan = { [weak session] in session?.scan() }
        view.onCancel = { [weak session] in session?.cancel() }
        session.onChange = { [weak session, weak view] in
            guard let session else { return }
            view?.update(phase: session.phase, permission: session.permission,
                         devices: session.devices, limited: session.resultLimitReached)
        }
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Pocket Printer Probe"
        window.contentView = view
        window.minSize = NSSize(width: 620, height: 600)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    func windowWillClose(_ notification: Notification) { session?.close() }
    func applicationWillTerminate(_ notification: Notification) { session?.close() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
enum PermissionProbeApplication {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = ProbeAppDelegate()
        app.delegate = delegate
        let menu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Pocket Printer Probe", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        menu.addItem(appMenuItem)
        app.mainMenu = menu
        withExtendedLifetime(delegate) { app.run() }
    }
}
