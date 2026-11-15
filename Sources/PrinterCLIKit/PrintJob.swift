import Foundation
import PocketPrinter5890Kit

public struct PrintJob {
    public let segments: [PrintSegment]
    public let rasterBands: Int
    public let feedDots: Int

    public static func image(_ bitmap: MonochromeBitmap) throws -> PrintJob {
        guard bitmap.width == RasterImage.width, (1...RasterImage.maximumHeight).contains(bitmap.height) else {
            throw CLIError.image("Print bitmap must be 384 pixels wide and 1...4096 pixels high.")
        }
        // Use upstream command/bitmap facilities, but omit PrintJobBuilder's
        // unconditional density write: this milestone must not change settings.
        let bands = RasterEncoder.bandedRasterCommands(for: bitmap, bandHeight: 24)
        let content = bands.enumerated().map {
            PrintSegment(name: "Raster band \($0.offset + 1)", bytes: $0.element)
        } + [PrintSegment(name: "Clearance feed", bytes: ESCPOS.feed(dots: 80))]
        return PrintJob(segments: activate(content), rasterBands: bands.count, feedDots: 80)
    }

    public static func feed(dots: Int) throws -> PrintJob {
        guard (1...255).contains(dots) else {
            throw CLIError.invalidInput("Feed must be 1...255 dots.")
        }
        return PrintJob(
            segments: activate([PrintSegment(name: "Feed", bytes: ESCPOS.feed(dots: dots))]),
            rasterBands: 0, feedDots: dots
        )
    }

    private static func activate(_ content: [PrintSegment]) -> [PrintSegment] {
        [
            PrintSegment(name: "Activate", bytes: PrinterCommand.Luck.enablePrinter()),
            PrintSegment(name: "Wake", bytes: PrinterCommand.Luck.wakeup)
        ] + content + [PrintSegment(name: "Stop job", bytes: PrinterCommand.Luck.stopPrintJob)]
    }

    public var summary: String {
        """
        DRY RUN ONLY: \(segments.count) separate segments, \(rasterBands) raster bands, \
        \(segments.reduce(0) { $0 + $1.bytes.count }) protocol bytes, \(feedDots) feed dots.
        No Bluetooth access, no bytes transmitted, no paper movement.
        """
    }

    public func requireSafeTransport() throws {
        // No public upstream API exposes notification readiness or fixes the
        // <=64-byte remaining-raster credit bypass. Never disguise that as success.
        throw CLIError.transportBlocked
    }
}
