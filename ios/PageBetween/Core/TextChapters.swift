import Foundation
import CoreFoundation

public struct TextChapter: Equatable, Sendable {
    public var title: String
    public var body: String
    public var sourceOffset: Int
}

public enum TextChapters {
    public static func decode(_ data: Data) throws -> String {
        if data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]), let text = String(data: data, encoding: .utf16) { return text }
        if let text = String(data: data, encoding: .utf8) { return text }
        let gb18030 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))
        if let text = String(data: data, encoding: gb18030) { return text }
        throw LibraryFailure.invalidFile
    }

    public static func parse(_ input: String) -> [TextChapter] {
        let clean = input.hasPrefix("\u{feff}") ? String(input.dropFirst()) : input
        let text = clean.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let pattern = #"(?im)^\s*(第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回卷部篇][^\n]{0,65}|(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+)[^\n]{0,65}|(?:序章|序言|前言|引子|楔子|尾声|后记|终章))\s*$"#
        let expression = try! NSRegularExpression(pattern: pattern)
        let source = text as NSString
        let headings = expression.matches(in: text, range: NSRange(location: 0, length: source.length))
        guard !headings.isEmpty else { return split(title: "全文", body: text, offset: 0) }
        var chapters: [TextChapter] = []
        let prefix = source.substring(to: headings[0].range.location).trimmingCharacters(in: .whitespacesAndNewlines)
        if !prefix.isEmpty { chapters += split(title: "开篇", body: prefix, offset: 0) }
        for (index, heading) in headings.enumerated() {
            let start = NSMaxRange(heading.range), end = index + 1 < headings.count ? headings[index + 1].range.location : source.length
            chapters += split(title: source.substring(with: heading.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines), body: source.substring(with: NSRange(location: start, length: end-start)), offset: start)
        }
        return chapters
    }

    private static func split(title: String, body: String, offset: Int) -> [TextChapter] {
        // Long unstructured novels must not become one enormous WebKit document.
        let source = body as NSString
        if source.length <= 30000 { return [TextChapter(title: title, body: body, sourceOffset: offset)] }
        var output: [TextChapter] = [], start = 0
        while start < source.length {
            var end = min(start + 24000, source.length)
            if end < source.length {
                let newline = source.range(of: "\n", options: .backwards, range: NSRange(location: start + 18000, length: end - start - 18000))
                if newline.location != NSNotFound { end = NSMaxRange(newline) }
                else if (0xD800...0xDBFF).contains(source.character(at: end - 1)) { end -= 1 }
            }
            output.append(TextChapter(title: output.isEmpty ? title : title + " · " + String(output.count+1), body: source.substring(with: NSRange(location: start, length: end-start)), sourceOffset: offset+start))
            start = end
        }
        return output
    }

    public static func escape(_ value: String) -> String {
        let valid = value.unicodeScalars.reduce(into: "") { result, scalar in
            let number = scalar.value
            result.unicodeScalars.append([9, 10, 13].contains(number) || (0x20...0xD7FF).contains(number) || (0xE000...0xFFFD).contains(number) || (0x10000...0x10FFFF).contains(number) ? scalar : "\u{FFFD}")
        }
        return valid.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&apos;")
    }
}
