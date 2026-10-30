import Foundation

public enum PDFTextAlignment {
    private struct Normalized { var units: [UInt32] = []; var offsets: [NSRange] = [] }
    private static func normalize(_ value: String, canonical: Bool) -> Normalized {
        let formulas = canonical ? MathText.spans(value) : []
        let source = value as NSString
        var result = Normalized(), offset = 0
        func append(_ text: String, range: NSRange) {
            let normalized = text.precomposedStringWithCompatibilityMapping.folding(options: [.caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
            for scalar in normalized.unicodeScalars where !CharacterSet.whitespacesAndNewlines.contains(scalar) {
                let quotes: [UInt32: UInt32] = [0x2018: 39, 0x2019: 39, 0x201c: 34, 0x201d: 34]
                result.units.append(quotes[scalar.value] ?? scalar.value); result.offsets.append(range)
            }
        }
        while offset < source.length {
            if let formula = formulas.first(where: { $0.range.location == offset }) {
                append(visibleMath(formula.expression), range: formula.range); offset = NSMaxRange(formula.range)
            } else {
                let range = source.rangeOfComposedCharacterSequence(at: offset)
                append(source.substring(with: range), range: range); offset = NSMaxRange(range)
            }
        }
        return result
    }
    private static func visibleMath(_ text: String) -> String {
        var value = text.replacingOccurrences(of: #"\\(?:begin|end)\s*\{[^}]*\}"#, with: "", options: .regularExpression)
        let symbols = ["emptyset":"∅", "varnothing":"∅", "in":"∈", "notin":"∉", "times":"×", "circ":"∘", "sim":"∼", "subset":"⊂", "subseteq":"⊆", "cup":"∪", "cap":"∩", "to":"→", "mapsto":"↦", "leq":"≤", "geq":"≥", "neq":"≠", "alpha":"α", "beta":"β", "gamma":"γ", "sigma":"σ", "tau":"τ", "pi":"π", "infty":"∞"]
        let decorations: Set<String> = ["bar", "overline", "underline", "hat", "tilde", "mathbf", "mathbb", "mathrm", "mathcal", "text", "operatorname", "left", "right", "displaystyle", "quad", "qquad"]
        let functions: Set<String> = ["sin", "cos", "tan", "log", "lim", "det", "exp"]
        let commands = try! NSRegularExpression(pattern: #"\\([A-Za-z]+)"#)
        let input = value as NSString, output = NSMutableString(string: value)
        for match in commands.matches(in: value, range: NSRange(location: 0, length: input.length)).reversed() {
            let command = input.substring(with: match.range(at: 1))
            output.replaceCharacters(in: match.range, with: symbols[command] ?? (decorations.contains(command) ? "" : functions.contains(command) ? command : "\u{fffc}"))
        }
        value = (output as String).replacingOccurrences(of: #"\\[,;! ]|[{}_^\\]"#, with: "", options: .regularExpression)
        return value.isEmpty ? "\u{fffc}" : value
    }
    public static func standaloneFormula(_ value: String) -> String? {
        let source = value as NSString, spans = MathText.spans(value)
        guard spans.count == 1, let span = spans.first,
              source.substring(to: span.range.location).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              source.substring(from: NSMaxRange(span.range)).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ",;:.!?，；：。！？"))).isEmpty else { return nil }
        return span.expression
    }
    public static func characterMap(_ original: String, canonical: String) -> [NSRange?]? {
        let a = normalize(original, canonical: false), b = normalize(canonical, canonical: true)
        guard !a.units.isEmpty, !b.units.isEmpty, a.units.count <= 16000, b.units.count <= 16000 else { return nil }
        typealias Match = (a: Int, b: Int, size: Int)
        var positions: [UInt32: [Int]] = [:]
        for (index, unit) in b.units.enumerated() { positions[unit, default: []].append(index) }
        var prefix = 0, suffix = 0
        while prefix < min(a.units.count, b.units.count), a.units[prefix] == b.units[prefix] { prefix += 1 }
        while suffix < min(a.units.count, b.units.count) - prefix, a.units[a.units.count - suffix - 1] == b.units[b.units.count - suffix - 1] { suffix += 1 }
        var pending: [(Int, Int, Int, Int)] = [], matches: [Match] = [], work = 0
        if prefix > 0 { matches.append((0,0,prefix)) }
        if suffix > 0 { matches.append((a.units.count - suffix,b.units.count - suffix,suffix)) }
        if prefix < a.units.count - suffix && prefix < b.units.count - suffix { pending.append((prefix, a.units.count - suffix, prefix, b.units.count - suffix)) }
        while let (a0, a1, b0, b1) = pending.popLast() {
            var best: Match = (a0, b0, 0), previous: [Int: Int] = [:]
            for i in a0..<a1 {
                var current: [Int: Int] = [:]
                for j in positions[a.units[i]] ?? [] where j >= b0 && j < b1 {
                    work += 1
                    guard work <= 8_000_000 else { return nil }
                    let length = (previous[j - 1] ?? 0) + 1
                    current[j] = length
                    if length > best.size { best = (i - length + 1, j - length + 1, length) }
                }
                previous = current
            }
            guard best.size > 0 else { continue }
            matches.append(best)
            if a0 < best.a && b0 < best.b { pending.append((a0, best.a, b0, best.b)) }
            if best.a + best.size < a1 && best.b + best.size < b1 { pending.append((best.a + best.size, a1, best.b + best.size, b1)) }
        }
        matches.sort { $0.a < $1.a }
        var merged: [Match] = []
        for match in matches {
            if let last = merged.last, last.a + last.size == match.a, last.b + last.size == match.b { merged[merged.count - 1].size += match.size }
            else { merged.append(match) }
        }
        guard Double(merged.reduce(0) { $0 + $1.size }) * 2 / Double(a.units.count + b.units.count) >= 0.65 else { return nil }
        merged.append((a.units.count, b.units.count, 0))
        var result = [NSRange?](repeating: nil, count: (original as NSString).length)
        func assign(_ a0: Int, _ a1: Int, _ b0: Int, _ b1: Int) {
            guard a0 < a1 else { return }
            for index in a0..<a1 {
                let target: NSRange
                if b0 == b1 { target = NSRange(location: b0 < b.offsets.count ? b.offsets[b0].location : (canonical as NSString).length, length: 0) }
                else {
                    let lo = b0 + (index - a0) * (b1 - b0) / (a1 - a0)
                    let hi = b0 + ((index - a0 + 1) * (b1 - b0) + a1 - a0 - 1) / (a1 - a0)
                    target = NSUnionRange(b.offsets[lo], b.offsets[hi - 1])
                }
                for offset in a.offsets[index].location..<NSMaxRange(a.offsets[index]) { result[offset] = result[offset].map { NSUnionRange($0, target) } ?? target }
            }
        }
        var left = 0, right = 0
        for match in merged {
            if max(match.a - left, match.b - right) <= max(20, Int(Double(a.units.count) * 0.15)) { assign(left, match.a, right, match.b) }
            assign(match.a, match.a + match.size, match.b, match.b + match.size)
            left = match.a + match.size; right = match.b + match.size
        }
        return result
    }
    public static func selected(_ original: String, canonical: String, ranges: [NSRange]) -> String? {
        guard let mapping = characterMap(original, canonical: canonical) else { return nil }
        return selected(mapping: mapping, canonical: canonical, ranges: ranges)
    }
    static func selected(mapping: [NSRange?], canonical: String, ranges: [NSRange]) -> String? {
        guard !ranges.isEmpty else { return nil }
        let source = canonical as NSString
        var output: [String] = []
        for range in ranges {
            guard range.location >= 0, range.length > 0, range.location <= mapping.count, range.length <= mapping.count - range.location else { return nil }
            let mapped = mapping[range.location..<NSMaxRange(range)].compactMap { $0 }.filter { $0.length > 0 }
            guard let first = mapped.first else { return nil }
            let interval = mapped.dropFirst().reduce(first, NSUnionRange)
            output.append(source.substring(with: interval))
        }
        return output.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
