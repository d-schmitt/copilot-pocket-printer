import AppKit
import Foundation

public enum BluetoothPreflight {
    public static func checkKnownHost() throws {
        let identifier = ProcessInfo.processInfo.environment["__CFBundleIdentifier"]
        guard identifier == "com.github.githubapp" else { return }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.github.githubapp"),
              let bundle = Bundle(url: url) else {
            throw CLIError.bluetoothUnavailable("Cannot inspect the known Copilot host's Bluetooth usage metadata. Stopped before CoreBluetooth initialization.")
        }
        let description = bundle.object(forInfoDictionaryKey: "NSBluetoothAlwaysUsageDescription") as? String
        try checkKnownHost(bundleIdentifier: identifier, usageDescription: description)
    }

    public static func checkKnownHost(bundleIdentifier: String?, usageDescription: String?) throws {
        // TCC logs on the development Mac attribute this CLI to Copilot, not
        // its own embedded plist. Preflight the observed host before TCC aborts.
        // The inherited marker is a conservative guard, not a universal TCC API.
        guard bundleIdentifier == "com.github.githubapp",
              usageDescription?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false else { return }
        throw CLIError.bluetoothHostMissingDescription
    }
}
