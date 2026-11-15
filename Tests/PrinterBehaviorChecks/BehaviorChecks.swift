import CoreGraphics
import Foundation
import PocketPrinter5890BLE
import PocketPrinter5890Kit
import PrinterCLIKit

public struct BehaviorChecks {
    public init() {}

    public var cases: [(name: String, run: () throws -> Void)] {
        [
            ("command parsing and invalid options", commandParsing),
            ("German and ASCII transliteration", transliteration),
            ("PNG threshold, bit order and row order", thresholdAndOrder),
            ("transparent pixels composite to white", transparency),
            ("malformed, wrong-width and oversized PNG rejection", invalidImages),
            ("separate activation, raster bands and no configuration writes", rasterJob),
            ("feed activation and physical-operation guard", physicalGuard),
            ("credits never resolve status requests", creditFrames),
            ("exact and unambiguous printer selection", selection),
            ("12-band test pattern and overwrite refusal", pattern),
            ("known TCC host preflight", hostPreflight)
        ]
    }

    private func commandParsing() throws {
        let options = try CLIOptions.parse(["print", "my card.png", "--dry-run"])
        try equal(options.command, .printPNG("my card.png"))
        try expect(options.dryRun)
        try equal(CLIOptions.parse(["feed"]).command, .feed(80))
        try equal(CLIOptions.parse(["feed", "255", "--dry-run"]).command, .feed(255))
        let id = UUID()
        let status = try CLIOptions.parse(["status", "--device", id.uuidString, "--timeout", "1"])
        try equal(status.device, id)
        try equal(status.timeout, 1)
        for arguments in [
            ["print"], ["print", "one.png", "two.png"], ["feed", "0"], ["feed", "256"],
            ["feed", "1.5"], ["status", "--dry-run"], ["print", "x.png", "--device", id.uuidString],
            ["status", "--timeout", "nan"], ["status", "--timeout", "31"],
            ["status", "--timeout"], ["status", "--device", "not-a-uuid"],
            ["feed", "--dry-run", "--dry-run"], ["test-pattern", "x.png", "--dry-run"]
        ] {
            try rejects { _ = try CLIOptions.parse(arguments) }
        }
    }

    private func transliteration() throws {
        try equal(
            ASCIIText.transliterate("F\u{00FC}\u{00DF}e \u{00C4}\u{00D6}\u{00DC} \u{1E9E} Gr\u{00F6}\u{00DF}e"),
            "Fuesse AeOeUe SS Groesse"
        )
        try equal(ASCIIText.transliterate("a\u{0308} o\u{0308} u\u{0308}"), "ae oe ue")
        try equal(ASCIIText.transliterate("caf\u{00E9} 18\u{00B0}C 12 \u{20AC}\n\u{1F600}"), "cafe 18degC 12 EUR\n?")
        try equal(ASCIIText.transliterate("safe\u{001B}[31m"), "safe?[31m")
    }

    private func thresholdAndOrder() throws {
        var pixels = [UInt8](repeating: 255, count: 384 * 2)
        pixels[0] = 159
        pixels[1] = 160
        for index in 384..<392 { pixels[index] = 0 }
        let image = try grayscaleImage(width: 384, height: 2, pixels: pixels)
        let bitmap = try RasterImage.decodePNG(RasterImage.pngData(for: image))
        try equal(bitmap.width, 384)
        try equal(bitmap.height, 2)
        try equal(bitmap.bytes[0], 0x80)
        try equal(bitmap.bytes[48], 0xff)
        try equal(bitmap.bytes[1], 0)
    }

    private func transparency() throws {
        var pixels = [UInt8](repeating: 0, count: 384 * 4)
        pixels[7] = 255
        let provider = try unwrap(CGDataProvider(data: Data(pixels) as CFData))
        let image = try unwrap(CGImage(
            width: 384, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 384 * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        ))
        let bitmap = try RasterImage.decodePNG(RasterImage.pngData(for: image))
        try equal(bitmap.bytes[0], 0x40)
        try equal(Array(bitmap.bytes.dropFirst()), [UInt8](repeating: 0, count: 47))
    }

    private func invalidImages() throws {
        try rejects { _ = try RasterImage.decodePNG(Data("not png".utf8)) }
        let wrongWidth = try grayscaleImage(width: 96, height: 1, pixels: [UInt8](repeating: 255, count: 96))
        try rejects { _ = try RasterImage.decodePNG(RasterImage.pngData(for: wrongWidth)) }
        let tooTall = try grayscaleImage(width: 384, height: 4097, pixels: [UInt8](repeating: 255, count: 384 * 4097))
        try rejects { _ = try RasterImage.decodePNG(RasterImage.pngData(for: tooTall)) }
        try rejects { _ = try RasterImage.decodePNG(Data(repeating: 0, count: RasterImage.maximumFileBytes + 1)) }
        let valid = try TestPattern.pngData()
        try rejects { _ = try RasterImage.decodePNG(valid.prefix(40)) }
        try rejects { _ = try RasterImage.loadPNG(at: URL(fileURLWithPath: "/nonexistent-pocket-printer-test.png")) }
    }

    private func rasterJob() throws {
        let bitmap = try MonochromeBitmap(height: 49, bytes: (0..<(48 * 49)).map { UInt8($0 % 251) })
        let job = try PrintJob.image(bitmap)
        try equal(job.segments[0].bytes, [0x10, 0xff, 0xf1, 0x03])
        try equal(job.segments[1].bytes, [UInt8](repeating: 0, count: 12))
        try equal(job.rasterBands, 3)
        try equal(job.segments.count, 7)
        let bands = Array(job.segments[2...4])
        try equal(bands.map { Array($0.bytes.prefix(8)) }, [
            [0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 24, 0],
            [0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 24, 0],
            [0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 1, 0]
        ])
        try equal(bands.flatMap { $0.bytes.dropFirst(8) }, bitmap.bytes)
        try equal(job.segments[5].bytes, [0x1b, 0x4a, 80])
        try equal(job.segments[6].bytes, [0x10, 0xff, 0xf1, 0x45])
    }

    private func physicalGuard() throws {
        let job = try PrintJob.feed(dots: 80)
        try equal(job.segments.map(\.bytes), [
            [0x10, 0xff, 0xf1, 0x03], [UInt8](repeating: 0, count: 12),
            [0x1b, 0x4a, 80], [0x10, 0xff, 0xf1, 0x45]
        ])
        try rejects { _ = try PrintJob.feed(dots: 0) }
        try rejects { _ = try PrintJob.feed(dots: 256) }
        let bitmap = try RasterImage.decodePNG(TestPattern.pngData())
        for operation in [job, try PrintJob.image(bitmap)] {
            try rejects({ try operation.requireSafeTransport() }, verify: { error in
                try equal((error as? CLIError)?.code, "upstream_transport_blocked")
                try equal((error as? CLIError)?.exitCode, 6)
            })
        }
    }

    private func creditFrames() throws {
        for context in ["model", "firmware", "battery", "paper"] {
            for credits: UInt8 in [0, 1, 4, 98, 255] {
                try expect(!ResponseDecoder.looksLikeSolicitedResponse([0x01, credits], context: context))
            }
        }
        try expect(ResponseDecoder.looksLikeSolicitedResponse([0x00, 98], context: "battery"))
        // Additive accounting is private to BLE. These checks do not verify it;
        // no physical transfer is allowed until that upstream gap is resolved.
    }

    private func selection() throws {
        let first = PrinterDevice(id: UUID(), name: "Mini Pocket Printer_BLE", rssi: -70, isLikelyL13: true)
        let second = PrinterDevice(id: UUID(), name: first.name, rssi: -20, isLikelyL13: true)
        let unrelated = PrinterDevice(id: UUID(), name: "DP-L13", rssi: -10, isLikelyL13: true)
        try equal(PrinterSelection.choose([unrelated, first], id: nil), first)
        try rejects({ _ = try PrinterSelection.choose([first, second], id: nil) }, verify: { error in
            try equal((error as? CLIError)?.code, "printer_ambiguous")
        })
        try rejects { _ = try PrinterSelection.choose([unrelated], id: nil) }
        try rejects { _ = try PrinterSelection.choose([first], id: UUID()) }
        try equal(PrinterSelection.choose([first, second], id: second.id), second)
    }

    private func pattern() throws {
        let bitmap = try RasterImage.decodePNG(TestPattern.pngData())
        try equal(bitmap.width, 384)
        try equal(bitmap.height, 288)
        try equal(PrintJob.image(bitmap).rasterBands, 12)
        try expect(bitmap.bytes.prefix(48).allSatisfy { $0 == 0xff })
        try expect(bitmap.bytes.suffix(48).allSatisfy { $0 == 0xff })
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        defer { try? FileManager.default.removeItem(at: url) }
        try TestPattern.write(to: url)
        let original = try Data(contentsOf: url)
        try rejects { try TestPattern.write(to: url) }
        try equal(Data(contentsOf: url), original)
    }

    private func hostPreflight() throws {
        for description: String? in [nil, "", " \n"] {
            try rejects({
                try BluetoothPreflight.checkKnownHost(bundleIdentifier: "com.github.githubapp", usageDescription: description)
            }, verify: { error in
                try equal((error as? CLIError)?.code, "bluetooth_host_missing_description")
                try equal((error as? CLIError)?.exitCode, 3)
            })
        }
        try BluetoothPreflight.checkKnownHost(bundleIdentifier: "com.github.githubapp", usageDescription: "Discover printers")
        try BluetoothPreflight.checkKnownHost(bundleIdentifier: nil, usageDescription: nil)
    }

    private func grayscaleImage(width: Int, height: Int, pixels: [UInt8]) throws -> CGImage {
        let provider = try unwrap(CGDataProvider(data: Data(pixels) as CFData))
        return try unwrap(CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        ))
    }
}

private struct CheckFailure: Error, CustomStringConvertible {
    let description: String
}

private func expect(_ condition: Bool, file: StaticString = #fileID, line: UInt = #line) throws {
    guard condition else { throw CheckFailure(description: "\(file):\(line): condition failed") }
}

private func equal<T: Equatable>(_ actual: T, _ expected: T, file: StaticString = #fileID, line: UInt = #line) throws {
    guard actual == expected else {
        throw CheckFailure(description: "\(file):\(line): got \(actual), expected \(expected)")
    }
}

private func unwrap<T>(_ value: T?, file: StaticString = #fileID, line: UInt = #line) throws -> T {
    guard let value else { throw CheckFailure(description: "\(file):\(line): unexpected nil") }
    return value
}

private func rejects(
    _ operation: () throws -> Void, verify: (Error) throws -> Void = { _ in },
    file: StaticString = #fileID, line: UInt = #line
) throws {
    var received: Error?
    do { try operation() } catch { received = error }
    guard let received else { throw CheckFailure(description: "\(file):\(line): expected failure") }
    try verify(received)
}
