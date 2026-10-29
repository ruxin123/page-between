import Foundation

public enum MathText {
    public struct Span: Sendable {
        public let range: NSRange
        public let raw: String
        public let expression: String
    }
    public struct Restored: Sendable {
        public let text: String
        public let needsReview: Bool
    }
    private static let pattern = try! NSRegularExpression(pattern: #"(?s)\$\$.*?\$\$|\\\[.*?\\\]|\\\(.*?\\\)|(?<!\\)\$(?!\$)[^\n$]+?(?<!\\)\$(?!\d)"#)
    public static func spans(_ text: String) -> [Span] {
        let string = text as NSString
        return pattern.matches(in: text, range: NSRange(location: 0, length: string.length)).map {
            let raw = string.substring(with: $0.range)
            let delimiter = raw.hasPrefix("$$") || raw.hasPrefix("\\") ? 2 : 1
            return Span(range: $0.range, raw: raw, expression: String(raw.dropFirst(delimiter).dropLast(delimiter)))
        }
    }
    public static func prose(_ text: String) -> String {
        let result = NSMutableString(string: text)
        for span in spans(text).reversed() { result.replaceCharacters(in: span.range, with: " ") }
        return result as String
    }
    private static func canonical(_ text: String) -> String {
        var value = text
        for (command, symbol) in [("\\sigma", "σ"), ("\\tau", "τ"), ("\\alpha", "α"), ("\\beta", "β"), ("\\varnothing", "∅"), ("\\emptyset", "∅"), ("\\in", "∈"), ("\\to", "→"), ("\\circ", "∘")] {
            value = value.replacingOccurrences(of: NSRegularExpression.escapedPattern(for: command) + "(?![A-Za-z])", with: symbol, options: .regularExpression)
        }
        return value.replacingOccurrences(of: #"\\(?:left|right)(?![A-Za-z])|[\s{}]"#, with: "", options: .regularExpression)
    }
    public static func restore(_ translation: String, source: String) -> Restored {
        let originals = spans(source), incoming = spans(translation)
        guard !originals.isEmpty else { return Restored(text: translation, needsReview: false) }
        let groups = Dictionary(grouping: originals.indices, by: { canonical(originals[$0].expression) })
        let result = NSMutableString(string: translation)
        var used = Set<Int>(), replacements: [(NSRange, String)] = [], unresolved = false
        for span in incoming {
            let candidates = (groups[canonical(span.expression)] ?? []).filter { !used.contains($0) }
            // Equal visible expressions with different original notation are ambiguous.
            let distinct = Set(candidates.map { originals[$0].raw })
            if let candidate = candidates.first, distinct.count == 1 {
                used.insert(candidate); replacements.append((span.range, originals[candidate].raw))
            } else { unresolved = true }
        }
        for replacement in replacements.sorted(by: { $0.0.location > $1.0.location }) { result.replaceCharacters(in: replacement.0, with: replacement.1) }
        return Restored(text: result as String, needsReview: unresolved || used.count != originals.count)
    }
}
