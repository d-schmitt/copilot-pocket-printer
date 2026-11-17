import CardRendererKit
import CoreGraphics
import Foundation
import ImageIO
import PrinterCLIKit

public struct CardChecks {
    public init() {}
    public var cases: [(name: String, run: () throws -> Void)] {
        [
            ("ASCII wrapping, raster margins, bounds and helper limits", layout),
            ("measured header alignment and compact fit/fallback", compactLayout),
            ("invalid schema, long words and overflow reject without truncation", invalid),
            ("original Sudoku uniqueness, difficulty and hidden solution", sudoku),
            ("bottom variants are deterministic and visibly populated", variants)
        ]
    }
    private func expect(_ condition: @autoclosure () throws -> Bool, line: Int = #line) throws {
        if try !condition() { throw CardError.invalid("Card assertion failed at line \(line).") }
    }
    private func encoded(_ blocks: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["version": 1, "blocks": blocks])
    }
    private func text(_ value: String, style: String = "body") -> [String: Any] {
        ["kind": "text", "style": style, "text": value]
    }
    private func rejects(_ data: Data) throws {
        do { _ = try CardRenderer.render(data) }
        catch { return }
        throw CardError.invalid("Expected invalid template to be rejected.")
    }
    private func layout() throws {
        let card = try CardRenderer.render(encoded([
            text("F\u{00FC}\u{00DF}e, Gr\u{00F6}\u{00DF}e, \u{00C4}rger", style: "title"),
            text("This sentence must wrap without losing any words or cutting off the right edge."),
            ["kind": "rule"], text("BOTTOM gyjp")
        ]))
        let bitmap = try RasterImage.decodePNG(card.png)
        try expect(bitmap.width == 384 && bitmap.height == card.report.height)
        try expect(card.png.count <= 1024 * 1024 && card.report.height <= 4096)
        let lines = card.report.elements.compactMap(\.text)
        try expect(lines.joined(separator: " ").hasPrefix("Fuesse, Groesse, Aerger"))
        try expect(lines.joined(separator: " ").contains("without losing any words"))
        try expect(lines.last == "BOTTOM gyjp")
        for element in card.report.elements {
            try expect(element.x >= 16 && element.x + element.width <= 368)
            try expect(element.y >= 16 && element.y + element.height <= card.report.height - 16)
            let rows = bitmap.bytes[(element.y * 48)..<((element.y + element.height) * 48)]
            try expect(rows.contains(where: { $0 != 0 }))
        }
        try expect(bitmap.bytes.prefix(48 * 16).allSatisfy { $0 == 0 })
        try expect(bitmap.bytes.suffix(48 * 16).allSatisfy { $0 == 0 })
        for row in 0..<bitmap.height {
            try expect(bitmap.bytes[row * 48] == 0 && bitmap.bytes[row * 48 + 47] == 0)
        }
        let source = CGImageSourceCreateWithData(card.png as CFData, nil)!
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        let pixels = image.dataProvider!.data! as Data
        try expect(pixels.allSatisfy { $0 == 0 || $0 == 255 })
    }
    private func invalid() throws {
        for value in [
            Data("null".utf8), Data("{\"version\":true,\"blocks\":[]}".utf8),
            Data(repeating: 32, count: CardRenderer.maximumInputBytes + 1),
            try encoded([["kind": "text", "text": "secret", "style": "body", "subject": "not allowed"]]),
            try encoded([text(String(repeating: "W", count: 100))]),
            try encoded([["kind": "sudoku", "difficulty": "easy", "seed": true]]),
            try encoded([["kind": "sudoku", "difficulty": "easy", "seed": 1, "solution": "not allowed"]]),
            try encoded([["kind": "art", "name": "untrusted.svg"]]),
            try encoded([["kind": "header", "left": String(repeating: "W", count: 30), "right": "19:06"]]),
            try encoded([["kind": "header", "left": "DAILY\nCARD", "right": "19:06"]]),
            try encoded([["kind": "compact", "items": [["text": "only one", "style": "body"]]]]),
            try encoded([["kind": "compact", "separator": 42, "items": [
                ["text": "Date", "style": "heading"], ["text": "Place", "style": "body"]
            ]]]),
            try encoded([["kind": "compact", "separator": "\n", "items": [
                ["text": "Date", "style": "heading"], ["text": "Place", "style": "body"]
            ]]]),
            try encoded([["kind": "compact", "items": [
                ["text": String(repeating: "W", count: 100), "style": "body"], ["text": "Last", "style": "body"]
            ]]]),
            try encoded([text(String(repeating: "wrapped words ", count: 240), style: "title")])
        ] { try rejects(value) }
        // Precisely at the height limit passes; one more line fails, not crops.
        let full = try encoded(Array(repeating: text("x\nx\nx\nx", style: "title"), count: 31) +
                               [text("x\nx\nx", style: "title")])
        try expect(CardRenderer.render(full).report.height == 4096)
        try rejects(encoded(Array(repeating: text("x\nx\nx\nx", style: "title"), count: 32)))
    }
    private func compactLayout() throws {
        func pair(_ first: String, _ second: String, firstStyle: String = "body", separator: String = " / ") -> [String: Any] {
            ["kind": "compact", "separator": separator, "items": [
                ["text": first, "style": firstStyle], ["text": second, "style": "body"]
            ]]
        }
        let card = try CardRenderer.render(encoded([
            ["kind": "header", "left": "DAILY CARD", "right": "19:06"],
            pair("Sunday 2026-11-15", "Friedrichshafen", firstStyle: "heading", separator: "  "),
            pair("First 09:00-10:00", "Last 15:00-16:00")
        ]))
        let title = card.report.elements[0], time = card.report.elements[1]
        try expect(title.y == time.y && title.height == time.height)
        try expect(title.x + title.width + 16 <= time.x)
        try expect(time.x + time.width == 368)
        try expect(card.report.elements[2].y == card.report.elements[3].y)
        try expect(card.report.elements[2].x + card.report.elements[2].width <= card.report.elements[3].x)
        try expect(card.report.elements.last?.text == "First 09:00-10:00 / Last 15:00-16:00")

        let longer = try CardRenderer.render(encoded([
            pair("Wednesday 2026-11-18", "Friedrichshafen", firstStyle: "heading", separator: "  "),
            pair("First 02:15 +02:00-02:45 +02:00", "Last 02:15 +01:00-02:45 +01:00")
        ]))
        try expect(longer.report.elements.compactMap(\.text) == [
            "Wednesday 2026-11-18", "Friedrichshafen",
            "First 02:15 +02:00-02:45 +02:00", "Last 02:15 +01:00-02:45 +01:00"
        ])
        for (a, b) in zip(longer.report.elements, longer.report.elements.dropFirst()) {
            try expect(a.y + a.height <= b.y)
        }
        // Compare actual glyph pixels against the pre-existing style renderer.
        let control = try CardRenderer.render(encoded([text("DAILY CARD", style: "title"), text("19:06", style: "small")]))
        let actualPixels = try RasterImage.decodePNG(card.png), controlPixels = try RasterImage.decodePNG(control.png)
        for (actual, original) in zip([title, time], control.report.elements) {
            for row in 0..<original.height {
                for column in 0..<actual.width {
                    let x = actual.x + column, controlX = original.x + column
                    let a = actualPixels.bytes[(actual.y + row) * 48 + x / 8] & (0x80 >> (x % 8)) != 0
                    let b = controlPixels.bytes[(original.y + row) * 48 + controlX / 8] & (0x80 >> (controlX % 8)) != 0
                    try expect(a == b)
                }
            }
        }
    }
    private func sudoku() throws {
        for difficulty in ["easy", "medium"] {
            for seed: UInt32 in [0, 1, 8, 9, .max] {
                let puzzle = try Sudoku.puzzle(difficulty: difficulty, seed: seed)
                try expect(Sudoku.solutionCount(puzzle) == 1)
                try expect(puzzle.filter { $0 == 0 }.count >= 38)
                try expect(grade(puzzle) == difficulty)
                let card = try CardRenderer.render(encoded([["kind": "sudoku", "difficulty": difficulty, "seed": seed]]))
                let bitmap = try RasterImage.decodePNG(card.png)
                // Each blank's inner area must remain blank in the actual image.
                for (i, digit) in puzzle.enumerated() {
                    let top = 16 + 4 + (i / 9) * 36
                    var black = false
                    for y in (top + 5)..<(top + 30) {
                        for x in (30 + i % 9 * 36 + 5)..<(30 + i % 9 * 36 + 31) {
                            black = black || (bitmap.bytes[y * 48 + x / 8] & (0x80 >> (x % 8)) != 0)
                        }
                    }
                    try expect(black == (digit != 0))
                }
            }
        }
        try expect(Sudoku.solutionCount([Int](repeating: 0, count: 81)) == 2)
        var invalid = [Int](repeating: 0, count: 81)
        invalid[0] = 1; invalid[1] = 1
        try expect(Sudoku.solutionCount(invalid) == 0)
    }
    private func variants() throws {
        for block: [String: Any] in [
            ["kind": "art", "name": "garden"],
            ["kind": "art", "name": "printer"],
            ["kind": "sudoku", "difficulty": "medium", "seed": 3],
            text("The pencil joined the garden club. It wanted to draw more flowers.")
        ] {
            let data = try encoded([text("Synthetic example", style: "heading"), block, text("END")])
            let a = try CardRenderer.render(data), b = try CardRenderer.render(data)
            try expect(RasterImage.decodePNG(a.png) == RasterImage.decodePNG(b.png))
            try expect(a.report.elements.last?.text == "END")
            if let kind = block["kind"] as? String, kind == "sudoku" || kind == "art",
               let element = a.report.elements.first(where: { $0.kind == kind }) {
                let bare = try CardRenderer.render(encoded([block]))
                let actual = try RasterImage.decodePNG(a.png), original = try RasterImage.decodePNG(bare.png)
                try expect(element.height == bare.report.elements[0].height)
                try expect(Array(actual.bytes[(element.y * 48)..<((element.y + element.height) * 48)]) ==
                           Array(original.bytes[(16 * 48)..<((16 + element.height) * 48)]))
            }
        }
    }

    // Independent logical grader: labels describe the solving techniques needed,
    // not a clue-count guess. A stuck grid would require an unsupported technique.
    private func grade(_ input: [Int]) -> String {
        let rows = (0..<9).map { r in (0..<9).map { r * 9 + $0 } }
        let columns = (0..<9).map { c in (0..<9).map { $0 * 9 + c } }
        let boxes = (0..<9).map { b in (0..<9).map { (b / 3 * 3 + $0 / 3) * 9 + b % 3 * 3 + $0 % 3 } }
        let units = rows + columns + boxes
        var grid = input, hidden = false
        while grid.contains(0) {
            var candidates: [Int: Set<Int>] = [:]
            for i in 0..<81 where grid[i] == 0 {
                let peers = units.filter { $0.contains(i) }.flatMap { $0 }
                candidates[i] = Set(1...9).subtracting(peers.map { grid[$0] })
            }
            if let single = candidates.sorted(by: { $0.key < $1.key }).first(where: { $0.value.count == 1 }) {
                grid[single.key] = single.value.first!
                continue
            }
            var found = false
            for unit in units {
                for digit in 1...9 {
                    let places = unit.filter { candidates[$0]?.contains(digit) == true }
                    if places.count == 1 { grid[places[0]] = digit; found = true; hidden = true; break }
                }
                if found { break }
            }
            if !found { return "requires guessing" }
        }
        return hidden ? "medium" : "easy"
    }
}
