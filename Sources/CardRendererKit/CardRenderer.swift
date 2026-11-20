import CoreGraphics
import CoreText
import Foundation
import PrinterCLIKit

public enum CardError: LocalizedError {
    case invalid(String)
    public var errorDescription: String? {
        switch self { case .invalid(let message): return message }
    }
}

public struct CardElement: Codable {
    public let kind: String
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int
    public let text: String?
}

public struct CardReport: Codable {
    public let width: Int
    public let height: Int
    public let pngBytes: Int
    public let elements: [CardElement]
}

public struct RenderedCard {
    public let png: Data
    public let report: CardReport
}

public enum CardRenderer {
    public static let maximumInputBytes = 64 * 1024
    public static let maximumPNGBytes = 1024 * 1024
    private static let margin = 16
    private static let contentWidth = 352
    private static let fontSizes = ["title": 24, "heading": 18, "body": 16, "small": 13]

    private enum Drawing {
        case text(String, Int)
        case rule
        case sudoku([Int])
        case garden
        case printer
    }

    public static func render(_ data: Data) throws -> RenderedCard {
        guard data.count <= maximumInputBytes else { throw CardError.invalid("Template exceeds 64 KiB.") }
        let value: Any
        do { value = try JSONSerialization.jsonObject(with: data) }
        catch { throw CardError.invalid("Template must be valid JSON.") }
        guard let root = value as? [String: Any],
              Set(root.keys) == ["version", "blocks"],
              integer(root["version"]) == 1,
              let blocks = root["blocks"] as? [[String: Any]], (1...128).contains(blocks.count) else {
            throw CardError.invalid("Expected version 1 and 1...128 blocks, with no extra fields.")
        }
        var elements: [CardElement] = []
        var drawings: [Drawing] = []
        var y = margin
        func append(_ kind: String, height: Int, text: String? = nil, x: Int = margin,
                    width: Int = contentWidth, advance: Bool = true, drawing: Drawing) throws {
            guard y + height + margin <= RasterImage.maximumHeight else {
                throw CardError.invalid("Complete card exceeds 4096 dots; nothing was cropped or written.")
            }
            elements.append(CardElement(kind: kind, x: x, y: y, width: width, height: height, text: text))
            drawings.append(drawing)
            if advance { y += height }
        }
        for block in blocks {
            guard let kind = block["kind"] as? String else { throw CardError.invalid("Block kind is required.") }
            switch kind {
            case "header":
                guard Set(block.keys) == ["kind", "left", "right"],
                      let left = block["left"] as? String, let right = block["right"] as? String,
                      [left, right].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 4096 && !$0.contains("\n") }) else {
                    throw CardError.invalid("Header requires two bounded single-line strings.")
                }
                let title = ASCIIText.transliterate(left), detail = ASCIIText.transliterate(right)
                let titleWidth = Int(ceil(textWidth(title, size: 24)))
                let detailWidth = Int(ceil(textWidth(detail, size: 13)))
                guard titleWidth + detailWidth + margin <= contentWidth else {
                    throw CardError.invalid("Header text overlaps; shorten it rather than shrinking or clipping.")
                }
                try append("text", height: 32, text: title, width: titleWidth, advance: false,
                           drawing: .text(title, 24))
                try append("text", height: 32, text: detail, x: margin + contentWidth - detailWidth,
                           width: detailWidth, drawing: .text(detail, 13))
            case "compact":
                guard Set(block.keys) == ["kind", "items"] || Set(block.keys) == ["kind", "items", "separator"],
                      let items = block["items"] as? [[String: Any]], items.count == 2,
                      let separator = (block["separator"] ?? " / ") as? String,
                      separator.utf8.count <= 16, !separator.contains("\n") else {
                    throw CardError.invalid("Compact row requires exactly two styled text items.")
                }
                var runs: [(text: String, size: Int)] = []
                for item in items {
                    guard Set(item.keys) == ["text", "style"],
                          let text = item["text"] as? String, !text.isEmpty, text.utf8.count <= 4096, !text.contains("\n"),
                          let style = item["style"] as? String, let size = fontSizes[style] else {
                        throw CardError.invalid("Compact items require bounded single-line text and a supported style.")
                    }
                    runs.append((ASCIIText.transliterate(text), size))
                }
                let first = runs[0], second = runs[1]
                let suffix = ASCIIText.transliterate(separator) + second.text
                let firstWidth = Int(ceil(textWidth(first.text, size: first.size)))
                let suffixWidth = Int(ceil(textWidth(suffix, size: second.size)))
                let fits = first.size == second.size
                    ? textWidth(first.text + suffix, size: first.size) <= Double(contentWidth)
                    : firstWidth + suffixWidth <= contentWidth
                if fits {
                    if first.size == second.size {
                        let combined = first.text + suffix
                        try append("text", height: first.size + 8, text: combined, drawing: .text(combined, first.size))
                    } else {
                        let rowHeight = max(first.size, second.size) + 8
                        try append("text", height: rowHeight, text: first.text, width: firstWidth, advance: false,
                                   drawing: .text(first.text, first.size))
                        try append("text", height: rowHeight, text: suffix, x: margin + firstWidth, width: suffixWidth,
                                   drawing: .text(suffix, second.size))
                    }
                } else {
                    for run in runs {
                        for line in try wrap(run.text, size: run.size) {
                            try append("text", height: run.size + 8, text: line, drawing: .text(line, run.size))
                        }
                    }
                }
            case "text":
                guard Set(block.keys) == ["kind", "text", "style"],
                      let text = block["text"] as? String, !text.isEmpty, text.utf8.count <= 4096,
                      let style = block["style"] as? String,
                      let size = fontSizes[style] else {
                    throw CardError.invalid("Text requires bounded text and a title/heading/body/small style.")
                }
                let ascii = ASCIIText.transliterate(text)
                for line in try wrap(ascii, size: size) {
                    try append("text", height: size + 8, text: line, drawing: .text(line, size))
                }
            case "rule":
                guard Set(block.keys) == ["kind"] else { throw CardError.invalid("Rule accepts no extra fields.") }
                try append("rule", height: 16, drawing: .rule)
            case "sudoku":
                guard Set(block.keys) == ["kind", "difficulty", "seed"],
                      let difficulty = block["difficulty"] as? String,
                      let seed = integer(block["seed"]), (0...Int(UInt32.max)).contains(seed) else {
                    throw CardError.invalid("Sudoku requires difficulty and a 32-bit unsigned seed.")
                }
                try append("sudoku", height: 334, drawing: .sudoku(try Sudoku.puzzle(difficulty: difficulty, seed: UInt32(seed))))
            case "art":
                guard Set(block.keys) == ["kind", "name"],
                      let name = block["name"] as? String, ["garden", "printer"].contains(name) else {
                    throw CardError.invalid("Supported self-authored line art: garden or printer.")
                }
                try append("art", height: name == "garden" ? 256 : 156, drawing: name == "garden" ? .garden : .printer)
            default:
                throw CardError.invalid("Unsupported block kind.")
            }
        }
        let height = y + margin
        guard let context = CGContext(data: nil, width: 384, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 384, space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
            throw CardError.invalid("Cannot allocate card canvas.")
        }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 384, height: height))
        context.setFillColor(gray: 0, alpha: 1)
        context.setStrokeColor(gray: 0, alpha: 1)
        context.setShouldAntialias(false)
        context.setShouldSmoothFonts(false)
        for (element, drawing) in zip(elements, drawings) {
            let top = CGFloat(height - element.y)
            switch drawing {
            case .text(let value, let size):
                drawText(value, size: size, x: CGFloat(element.x), baseline: top - CGFloat(size + 2), context: context)
            case .rule:
                context.fill(CGRect(x: 16, y: top - 8, width: CGFloat(contentWidth), height: 2))
            case .sudoku(let puzzle):
                let left: CGFloat = 30, bottom = top - 328, cell: CGFloat = 36
                for n in 0...9 {
                    let thickness: CGFloat = n % 3 == 0 ? 3 : 1
                    context.fill(CGRect(x: left + CGFloat(n) * cell - 1, y: bottom - 1, width: thickness, height: 327))
                    context.fill(CGRect(x: left - 1, y: bottom + CGFloat(n) * cell - 1, width: 327, height: thickness))
                }
                for (i, digit) in puzzle.enumerated() where digit != 0 {
                    drawText(String(digit), size: 23, x: left + CGFloat(i % 9) * cell + 11,
                             baseline: bottom + CGFloat(8 - i / 9) * cell + 10, context: context)
                }
            case .garden:
                drawGarden(context, bottom: top - 250)
            case .printer:
                drawPrinter(context, bottom: top - 146)
            }
        }
        guard let image = context.makeImage() else { throw CardError.invalid("Cannot create card image.") }
        let png = try RasterImage.pngData(for: image)
        guard png.count <= maximumPNGBytes else { throw CardError.invalid("PNG exceeds the helper's 1 MiB limit.") }
        return RenderedCard(png: png, report: CardReport(width: 384, height: height, pngBytes: png.count, elements: elements))
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue <= Double(UInt32.max) else { return nil }
        return number.intValue
    }

    private static func line(_ text: String, size: Int) -> CTLine {
        CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Menlo" as CFString, CGFloat(size), nil),
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)
        ]))
    }

    private static func textWidth(_ text: String, size: Int) -> Double {
        CTLineGetTypographicBounds(line(text, size: size), nil, nil, nil)
    }

    private static func wrap(_ text: String, size: Int) throws -> [String] {
        var result: [String] = []
        for paragraph in text.components(separatedBy: "\n") {
            var current = ""
            for word in paragraph.split(separator: " ") {
                let candidate = current.isEmpty ? String(word) : current + " " + word
                if textWidth(candidate, size: size) <= Double(contentWidth) {
                    current = candidate
                } else {
                    guard !current.isEmpty else { throw CardError.invalid("An unbroken word exceeds the card width.") }
                    result.append(current)
                    current = String(word)
                    guard textWidth(current, size: size) <= Double(contentWidth) else {
                        throw CardError.invalid("An unbroken word exceeds the card width.")
                    }
                }
            }
            result.append(current)
        }
        return result
    }

    private static func drawText(_ text: String, size: Int, x: CGFloat, baseline: CGFloat, context: CGContext) {
        context.textPosition = CGPoint(x: x, y: baseline)
        CTLineDraw(line(text, size: size), context)
    }

    private static func drawGarden(_ context: CGContext, bottom: CGFloat) {
        // Original vector drawing. Open regions and two-dot strokes suit coloring.
        context.setLineWidth(2)
        context.stroke(CGRect(x: 18, y: bottom + 2, width: 348, height: 244))
        for (x, stemHeight) in [(100.0, 115.0), (198.0, 155.0), (288.0, 100.0)] {
            let center = CGPoint(x: x, y: bottom + stemHeight)
            context.move(to: CGPoint(x: x, y: bottom + 20))
            context.addLine(to: center)
            context.strokePath()
            for n in 0..<6 {
                let angle = Double(n) * .pi / 3
                context.strokeEllipse(in: CGRect(x: center.x + cos(angle) * 23 - 15,
                                                  y: center.y + sin(angle) * 23 - 15, width: 30, height: 30))
            }
            context.setFillColor(gray: 1, alpha: 1)
            context.fillEllipse(in: CGRect(x: x - 13, y: center.y - 13, width: 26, height: 26))
            context.strokeEllipse(in: CGRect(x: x - 13, y: center.y - 13, width: 26, height: 26))
            context.move(to: CGPoint(x: x, y: bottom + 42))
            context.addQuadCurve(to: CGPoint(x: x - 34, y: bottom + 74), control: CGPoint(x: x - 35, y: bottom + 35))
            context.addQuadCurve(to: CGPoint(x: x, y: bottom + 42), control: CGPoint(x: x, y: bottom + 78))
            context.strokePath()
        }
        context.setFillColor(gray: 0, alpha: 1)
    }

    private static func drawPrinter(_ context: CGContext, bottom: CGFloat) {
        context.setLineWidth(3)
        context.stroke(CGRect(x: 130, y: bottom + 88, width: 124, height: 50))
        context.stroke(CGRect(x: 106, y: bottom + 34, width: 172, height: 54))
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 128, y: bottom + 4, width: 128, height: 56))
        context.stroke(CGRect(x: 128, y: bottom + 4, width: 128, height: 56))
        context.setFillColor(gray: 0, alpha: 1)
        context.fillEllipse(in: CGRect(x: 258, y: bottom + 69, width: 7, height: 7))
        for y in [20, 33, 46, 105, 118] {
            context.fill(CGRect(x: 145, y: bottom + CGFloat(y), width: 94, height: 2))
        }
    }
}
