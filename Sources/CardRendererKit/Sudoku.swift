import Foundation

public enum Sudoku {
    // Original Latin-pattern grids, reduced with a uniqueness check. Easy needs
    // naked singles only; medium also needs hidden singles, never guessing.
    private static let puzzles = [
        "easy": "1..4567.....78..2378912....23.5.78.15.789..3.89..3.5.73..67..12.78..2.459....5.7.",
        "medium": "....567.....7....378.12....2..5.78.15.78...3.89..3.5.73..6...12.78..2.4.9........"
    ]

    public static func puzzle(difficulty: String, seed: UInt32) throws -> [Int] {
        guard let source = puzzles[difficulty] else {
            throw CardError.invalid("Sudoku difficulty must be easy or medium.")
        }
        let shift = Int(seed % 9)
        let grid = source.map { character -> Int in
            guard let digit = character.wholeNumberValue else { return 0 }
            return (digit - 1 + shift) % 9 + 1
        }
        let result = seed & 1 == 0 ? grid : (0..<81).map { grid[($0 % 9) * 9 + $0 / 9] }
        guard try solutionCount(result) == 1 else {
            throw CardError.invalid("Sudoku is not uniquely solvable.")
        }
        return result
    }

    public static func solutionCount(_ input: [Int]) throws -> Int {
        guard input.count == 81, input.allSatisfy({ (0...9).contains($0) }) else {
            throw CardError.invalid("Invalid Sudoku grid.")
        }
        var grid = input
        var rows = [Int](repeating: 0, count: 9)
        var columns = rows
        var boxes = rows
        for (index, digit) in grid.enumerated() where digit > 0 {
            let r = index / 9, c = index % 9, b = r / 3 * 3 + c / 3, bit = 1 << digit
            guard (rows[r] | columns[c] | boxes[b]) & bit == 0 else { return 0 }
            rows[r] |= bit; columns[c] |= bit; boxes[b] |= bit
        }
        var nodes = 0
        func search() throws -> Int {
            nodes += 1
            guard nodes <= 100_000 else { throw CardError.invalid("Sudoku search limit exceeded.") }
            var chosen = -1, mask = 0, count = 10
            for i in 0..<81 where grid[i] == 0 {
                let r = i / 9, c = i % 9, b = r / 3 * 3 + c / 3
                let candidates = 0x3fe & ~(rows[r] | columns[c] | boxes[b])
                let size = candidates.nonzeroBitCount
                if size == 0 { return 0 }
                if size < count { chosen = i; mask = candidates; count = size }
            }
            if chosen == -1 { return 1 }
            let r = chosen / 9, c = chosen % 9, b = r / 3 * 3 + c / 3
            var solutions = 0
            for digit in 1...9 where mask & (1 << digit) != 0 {
                let bit = 1 << digit
                grid[chosen] = digit; rows[r] |= bit; columns[c] |= bit; boxes[b] |= bit
                solutions += try search()
                grid[chosen] = 0; rows[r] &= ~bit; columns[c] &= ~bit; boxes[b] &= ~bit
                if solutions >= 2 { return 2 }
            }
            return solutions
        }
        return try search()
    }
}
