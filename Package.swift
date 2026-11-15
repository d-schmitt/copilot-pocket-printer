// swift-tools-version: 5.9

import Foundation
import PackageDescription

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
    name: "CopilotPocketPrinter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "printer-cli", targets: ["PrinterCLI"]),
        .executable(name: "printer-cli-checks", targets: ["PrinterCLIChecks"]),
        .executable(name: "permission-probe", targets: ["PermissionProbe"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/d-schmitt/PocketPrinter5890.git",
            revision: "f5a31521e5e415b8091a49f20cc836956947604b"
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
        .target(name: "PermissionProbeCore"),
        .target(name: "PermissionProbeUI", dependencies: ["PermissionProbeCore"]),
        .executableTarget(
            name: "PermissionProbe",
            dependencies: ["PermissionProbeCore", "PermissionProbeUI"]
        ),
        .target(
            name: "PrinterBehaviorChecks",
            dependencies: ["PrinterCLIKit", "PermissionProbeCore", "PermissionProbeUI"],
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
