import CoreGraphics
import CoreText
import Foundation

public enum TestPattern {
    public static func pngData() throws -> Data {
        let width = RasterImage.width
        let height = 288
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            throw CLIError.image("Cannot allocate test-pattern canvas.")
        }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setShouldAntialias(false)
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: 2))
        context.fill(CGRect(x: 0, y: height - 2, width: width, height: 2))
        context.fill(CGRect(x: 0, y: 0, width: 2, height: height))
        context.fill(CGRect(x: width - 2, y: 0, width: 2, height: height))

        func text(_ value: String, x: Int, y: Int, size: CGFloat = 14) {
            let attributes: [NSAttributedString.Key: Any] = [
                NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Menlo" as CFString, size, nil),
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)
            ]
            let line = CTLineCreateWithAttributedString(NSAttributedString(
                string: ASCIIText.transliterate(value), attributes: attributes
            ))
            context.textPosition = CGPoint(x: x, y: y)
            CTLineDraw(line, context)
        }

        text("POCKET PRINTER / TEST 01", x: 14, y: 263, size: 18)
        text("384 DOTS | 12 BANDS x 24 LINES", x: 14, y: 241)
        text("TOP: full border + readable text", x: 14, y: 220, size: 13)

        for band in 0..<6 {
            let y = 192 - band * 24
            text(String(format: "%02d", band + 4), x: 12, y: y + 5, size: 12)
            for x in stride(from: 48, to: 368, by: 16) {
                context.fill(CGRect(x: x, y: y + 2, width: 2 + band, height: 16))
            }
            context.fill(CGRect(x: 42, y: y, width: 328, height: 1))
        }
        text("Fuesse / Groesse / Aerger", x: 14, y: 50)
        text("BOTTOM: no gaps or missing bands", x: 14, y: 27, size: 13)
        text("Then 80 dots of clearance feed", x: 14, y: 10, size: 12)
        guard let image = context.makeImage() else {
            throw CLIError.image("Cannot create test-pattern image.")
        }
        return try RasterImage.pngData(for: image)
    }

    public static func write(to url: URL) throws {
        do {
            try pngData().write(to: url, options: .withoutOverwriting)
        } catch let error as CLIError {
            throw error
        } catch {
            throw CLIError.image("Cannot save test pattern (existing files are not overwritten): \(error.localizedDescription)")
        }
    }
}
