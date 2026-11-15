import Foundation

public enum ASCIIText {
    public static func transliterate(_ text: String) -> String {
        let replacements = [
            "\u{00E4}": "ae", "\u{00F6}": "oe", "\u{00FC}": "ue", "\u{00DF}": "ss",
            "\u{00C4}": "Ae", "\u{00D6}": "Oe", "\u{00DC}": "Ue", "\u{1E9E}": "SS",
            "\u{00B0}": "deg", "\u{20AC}": "EUR"
        ]
        var result = text.precomposedStringWithCanonicalMapping
        for (source, replacement) in replacements {
            result = result.replacingOccurrences(of: source, with: replacement)
        }
        result = result.folding(options: [.diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        return String(result.unicodeScalars.map { scalar in
            scalar.value == 10 || (32...126).contains(scalar.value) ? Character(scalar) : "?"
        })
    }
}
