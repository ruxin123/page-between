import Foundation

public struct PDFSourceObject: Codable, Equatable, Sendable {
    public var page: Int
    public var box: PDFBox
    public var type: String
    public var text: String
    public init(page: Int, box: PDFBox, type: String, text: String) { self.page = page; self.box = box; self.type = type; self.text = text }
    public var isValid: Bool { page > 0 && page <= 100000 && box.isValid && ["equation", "table", "image"].contains(type) && text.utf8.count <= 2_000_000 }
    public var markdown: String {
        if type == "equation", PDFTextAlignment.standaloneFormula(text) == nil { return "$$\n" + text + "\n$$" }
        return text
    }
}

public struct PDFSourceGlyph: Sendable {
    public var text: String
    public var box: PDFBox?
    public var selected: Bool
    public init(text: String, box: PDFBox?, selected: Bool) { self.text = text; self.box = box; self.selected = selected }
}

public struct PDFSelectedSource: Sendable {
    public var raw: String
    public var markdown: String
    public var objects: [PDFSourceObject]
    public init(raw: String, markdown: String, objects: [PDFSourceObject] = []) { self.raw = raw; self.markdown = markdown; self.objects = objects }
}

public enum PDFSelectionAssembler {
    public static func object(_ block: PDFContentBlock, page: Int) -> PDFSourceObject? {
        let type = block.type == "text" && PDFTextAlignment.standaloneFormula(block.text) != nil ? "equation" : block.type
        let object = PDFSourceObject(page: page, box: block.box, type: type, text: block.text)
        return object.isValid ? object : nil
    }
    public static func assemble(_ glyphs: [PDFSourceGlyph], blocks: [PDFContentBlock], page: Int) -> PDFSelectedSource {
        let fallback = glyphs.filter(\.selected).map(\.text).joined()
        guard glyphs.count <= 120000, blocks.count <= 10000 else { return PDFSelectedSource(raw: fallback, markdown: fallback) }
        var groups: [Int: [Int]] = [:], unmatched: [Int] = [], previous: Int?
        for (index, glyph) in glyphs.enumerated() {
            var group: Int?
            if let box = glyph.box {
                let x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2
                group = blocks.indices.filter { i in
                    let b = blocks[i].box
                    return ["text", "equation", "table"].contains(blocks[i].type) && !blocks[i].text.isEmpty && b.left - 0.003 <= x && x <= b.right + 0.003 && b.top - 0.003 <= y && y <= b.bottom + 0.003
                }.min { area(blocks[$0].box) < area(blocks[$1].box) }
            } else if glyph.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { group = previous }
            if let group { groups[group, default: []].append(index) }
            else if glyph.selected { unmatched.append(index) }
            previous = group
        }
        var pieces: [(index: Int, raw: String, markdown: String, objects: [PDFSourceObject])] = []
        for (group, indices) in groups {
            guard let first = indices.first(where: { glyphs[$0].selected }) else { continue }
            let block = blocks[group]
            if let object = object(block, page: page) { pieces.append((first, object.text, object.markdown, [object])); continue }
            var original = "", intervals: [NSRange] = [], glyphRanges: [(Int, NSRange)] = [], offset = 0
            for index in indices {
                let glyph = glyphs[index], length = (glyph.text as NSString).length
                original += glyph.text
                glyphRanges.append((index, NSRange(location: offset, length: length)))
                if glyph.selected {
                    if let last = intervals.last, NSMaxRange(last) == offset { intervals[intervals.count - 1].length += length }
                    else { intervals.append(NSRange(location: offset, length: length)) }
                }
                offset += length
            }
            let mapping = PDFTextAlignment.characterMap(original, canonical: block.text)
            let projected = mapping.flatMap { PDFTextAlignment.selected(mapping: $0, canonical: block.text, ranges: intervals) }
            let selected = projected ?? indices.filter { glyphs[$0].selected }.map { glyphs[$0].text }.joined()
            var objects: [PDFSourceObject] = []
            if let mapping, projected != nil {
                for span in MathText.spans(block.text) {
                    let matching = glyphRanges.filter { _, range in
                        mapping[range.location..<NSMaxRange(range)].contains { target in
                            target.map { NSIntersectionRange($0, span.range).length > 0 } ?? false
                        }
                    }
                    guard matching.contains(where: { glyphs[$0.0].selected }) else { continue }
                    let boxes = matching.compactMap { glyphs[$0.0].box }
                    guard let first = boxes.first else { continue }
                    let box = boxes.dropFirst().reduce(first) { PDFBox(min($0.left, $1.left), min($0.top, $1.top), max($0.right, $1.right), max($0.bottom, $1.bottom)) }
                    let object = PDFSourceObject(page: page, box: box, type: "equation", text: span.raw)
                    if object.isValid { objects.append(object) }
                }
            }
            pieces.append((first, selected, selected, objects))
        }
        var run: [Int] = []
        func flush() { if let first = run.first { let text = run.map { glyphs[$0].text }.joined(); pieces.append((first, text, text, [])); run = [] } }
        for index in unmatched { if let last = run.last, index != last + 1 { flush() }; run.append(index) }; flush()
        pieces.sort { $0.index < $1.index }
        return PDFSelectedSource(raw: pieces.map(\.raw).joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines), markdown: pieces.map(\.markdown).joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines), objects: pieces.flatMap(\.objects))
    }
    private static func area(_ box: PDFBox) -> Double { (box.right - box.left) * (box.bottom - box.top) }
}
