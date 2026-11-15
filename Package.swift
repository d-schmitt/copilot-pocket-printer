// swift-tools-version: 5.9

import Foundation
import PackageDescription

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
    name: "CopilotPocketPrinter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "printer-cli", targets: ["PrinterCLI"]),
        .executable(name: "printer-cli-checks", targets: ["PrinterCLIChecks"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/dimer47/PocketPrinter5890.git",
            revision: "20118975f6e58d5910657d7ba3daa62c3e5edae9"
        )
    ],
    targets: [
        .target(
            name: "PrinterCLIKit",
            dependencies: [
                .product(name: "PocketPrinter5890Kit", package: "PocketPrinter5890"),
                .product(name: "PocketPrinter5890BLE", package: "PocketPrinter5890")
            ]
        ),
        .executableTarget(
            name: "PrinterCLI",
            dependencies: ["PrinterCLIKit"],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "\(root)/Support/Info.plist"
                ])
            ]
        ),
        .target(
            name: "PrinterBehaviorChecks",
            dependencies: ["PrinterCLIKit"],
            path: "Tests/PrinterBehaviorChecks"
        ),
        .executableTarget(
            name: "PrinterCLIChecks",
            dependencies: ["PrinterBehaviorChecks"],
            path: "Tests/PrinterCLIChecks"
        ),
        .testTarget(name: "PrinterCLIKitTests", dependencies: ["PrinterBehaviorChecks"])
    ]
)
