import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

private final class FictionNode {
    enum Part { case text(String), node(FictionNode) }
    let name: String
    let attributes: [String: String]
    let namespace: String?
    var parts: [Part] = []
    init(_ name: String, _ attributes: [String: String], namespace: String? = nil) { self.name = name; self.attributes = attributes; self.namespace = namespace }
    var children: [FictionNode] { parts.compactMap { if case .node(let node) = $0 { return node }; return nil } }
    var text: String { parts.map { if case .text(let text) = $0 { return text }; if case .node(let node) = $0 { return node.text + (["p", "v"].contains(node.name) ? "\n" : "") }; return "" }.joined() }
    func child(_ name: String) -> FictionNode? { children.first { $0.name == name } }
    var href: String? { attributes.first { $0.key.split(separator: ":").last == "href" }?.value }
}

private final class FictionXML: NSObject, XMLParserDelegate {
    private var stack: [FictionNode] = []
    private var root: FictionNode?
    private var nodes = 0
    private var textSize = 0
    static func parse(_ data: Data) throws -> FictionNode {
        guard !data.isEmpty, data.count <= 50 * 1024 * 1024 else { throw LibraryFailure.invalidFile }
        let declarations = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\0", with: "")
        guard declarations.range(of: "<!DOCTYPE", options: .caseInsensitive) == nil, declarations.range(of: "<!ENTITY", options: .caseInsensitive) == nil else { throw LibraryFailure.invalidFile }
        let delegate = FictionXML(), parser = XMLParser(data: data)
        parser.shouldProcessNamespaces = true; parser.shouldResolveExternalEntities = false; parser.delegate = delegate
        guard parser.parse(), let root = delegate.root, delegate.stack.isEmpty else { throw LibraryFailure.invalidFile }
        return root
    }
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        nodes += 1
        guard nodes <= 200000, stack.count < 128 else { parser.abortParsing(); return }
        let node = FictionNode(name, attributes, namespace: namespaceURI)
        if let parent = stack.last { parent.parts.append(.node(node)) }
        else if root == nil { root = node }
        else { parser.abortParsing(); return }
        stack.append(node)
    }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) { _ = stack.popLast() }
    func parser(_ parser: XMLParser, foundCharacters string: String) {
        textSize += string.utf8.count
        guard textSize <= 50 * 1024 * 1024 else { parser.abortParsing(); return }
        stack.last?.parts.append(.text(string))
    }
    func parser(_ parser: XMLParser, foundCDATA data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { parser.abortParsing(); return }
        self.parser(parser, foundCharacters: text)
    }
}

public enum FB2Parser {
    public static func parse(_ data: Data, fallbackTitle: String) throws -> EPUBContent {
        let root = try FictionXML.parse(data)
        guard root.name == "FictionBook", let info = root.child("description")?.child("title-info") else { throw LibraryFailure.invalidFile }
        func clean(_ value: String?) -> String { (value ?? "").replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines) }
        let title = clean(info.child("book-title")?.text)
        let authors = info.children.filter { $0.name == "author" }.map { author in
            let name = ["first-name", "middle-name", "last-name"].map { clean(author.child($0)?.text) }.filter { !$0.isEmpty }.joined(separator: " ")
            return name.isEmpty ? clean(author.child("nickname")?.text) : name
        }.filter { !$0.isEmpty }.joined(separator: "、")
        let language = clean(info.child("lang")?.text)
        var chapters: [FictionNode] = []
        for body in root.children where body.name == "body" {
            var prefix = FictionNode("section", [:])
            func flush() { if !prefix.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prefix.children.contains(where: { $0.name == "image" }) { chapters.append(prefix) }; prefix = FictionNode("section", [:]) }
            for part in body.parts {
                if case .node(let node) = part, node.name == "section" { flush(); chapters.append(node) }
                else { prefix.parts.append(part) }
            }
            flush()
        }
        guard !chapters.isEmpty, chapters.count <= 10000 else { throw LibraryFailure.invalidFile }
        var identifiers: [String: String] = [:], anchors: [ObjectIdentifier: String] = [:], counter = 0
        func register(_ node: FictionNode, chapter: Int) throws {
            if node.name == "section" || node.attributes["id"] != nil {
                counter += 1; let anchor = "fb2-\(counter)"; anchors[ObjectIdentifier(node)] = anchor
                if let id = node.attributes["id"] {
                    guard !id.isEmpty, identifiers[id] == nil else { throw LibraryFailure.invalidFile }
                    identifiers[id] = "chapter-\(chapter).xhtml#" + anchor
                }
            }
            for child in node.children { try register(child, chapter: chapter) }
        }
        for (index, chapter) in chapters.enumerated() { try register(chapter, chapter: index) }
        var binaries: [String: FictionNode] = [:]
        for node in root.children where node.name == "binary" {
            guard let id = node.attributes["id"], !id.isEmpty, binaries[id] == nil else { throw LibraryFailure.invalidFile }
            binaries[id] = node
        }
        var resources: [EPUBResource] = [], resourceNames: [String: String] = [:]
        func image(_ href: String) throws -> String {
            guard href.hasPrefix("#"), let binary = binaries[String(href.dropFirst())] else { throw LibraryFailure.invalidFile }
            let id = String(href.dropFirst())
            if let name = resourceNames[id] { return name }
            let rawMIME = binary.attributes["content-type"]?.lowercased() ?? ""
            let mime = rawMIME == "image/jpg" ? "image/jpeg" : rawMIME
            let extensions = ["image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/svg+xml": "svg"]
            guard let ext = extensions[mime], resources.count < 1000,
                  let bytes = Data(base64Encoded: binary.text.components(separatedBy: .whitespacesAndNewlines).joined()), !bytes.isEmpty, bytes.count <= 16 * 1024 * 1024 else { throw LibraryFailure.invalidFile }
            switch mime {
            case "image/png": guard bytes.starts(with: [137,80,78,71,13,10,26,10]) else { throw LibraryFailure.invalidFile }
            case "image/jpeg": guard bytes.starts(with: [255,216,255]) else { throw LibraryFailure.invalidFile }
            case "image/gif": guard bytes.starts(with: Data("GIF8".utf8)) else { throw LibraryFailure.invalidFile }
            default: try validateSVG(bytes)
            }
            let name = "images/image-\(resources.count).\(ext)"
            resources.append(EPUBResource(name: name, mediaType: mime, data: bytes)); resourceNames[id] = name
            return name
        }
        let cover = try info.child("coverpage")?.child("image")?.href.map(image)
        func render(_ node: FictionNode, depth: Int = 1, inlineTitle: Bool = false) throws -> String {
            let id = anchors[ObjectIdentifier(node)].map { " id=\"" + $0 + "\"" } ?? ""
            if node.name == "image" {
                guard let href = node.href else { throw LibraryFailure.invalidFile }
                return "<img\(id) src=\"\(try image(href))\" alt=\"\(TextChapters.escape(node.attributes["alt"] ?? ""))\"/>"
            }
            if node.name == "empty-line" { return "<br\(id)/>" }
            let tags = ["section":"section", "p":"p", "emphasis":"em", "strong":"strong", "strikethrough":"s", "sub":"sub", "sup":"sup", "code":"code", "cite":"blockquote", "epigraph":"blockquote", "annotation":"div", "poem":"div", "stanza":"div", "v":"p", "text-author":"p", "date":"span", "table":"table", "tr":"tr", "td":"td", "th":"th", "subtitle":"h\(min(6, depth + 1))", "title":"h\(min(6, depth))", "a":"a"]
            let tag = inlineTitle && node.name == "p" ? "span" : tags[node.name] ?? "span"
            var attributes = id
            if node.name == "a", let href = node.href {
                if href.hasPrefix("#") { let id = String(href.dropFirst()); guard let target = identifiers[id] ?? identifiers[id.removingPercentEncoding ?? id] else { throw LibraryFailure.invalidFile }; attributes += " href=\"" + target + "\"" }
                else if let url = URL(string: href), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil { attributes += " href=\"" + TextChapters.escape(href) + "\"" }
            }
            for name in ["colspan", "rowspan"] where ["td", "th"].contains(node.name) {
                if let value = node.attributes[name], let count = Int(value), (1...100).contains(count) { attributes += " \(name)=\"\(count)\"" }
            }
            let parts = node.name == "title" ? node.parts.filter { if case .text(let text) = $0 { return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }; return true } : node.parts
            let content = try parts.map { part in
                switch part {
                case .text(let text): return TextChapters.escape(text)
                case .node(let child): return try render(child, depth: child.name == "section" ? depth + 1 : depth, inlineTitle: inlineTitle || node.name == "title")
                }
            }.joined(separator: node.name == "title" ? "<br/>" : "")
            return "<\(tag)\(attributes)>\(content)</\(tag)>"
        }
        func headings(_ node: FictionNode) -> [EPUBHeading] {
            node.children.filter { $0.name == "section" }.flatMap { section -> [EPUBHeading] in
                let title = clean(section.child("title")?.text)
                let children = headings(section)
                guard !title.isEmpty, let anchor = anchors[ObjectIdentifier(section)] else { return children }
                return [EPUBHeading(title: title, anchor: anchor, children: children)]
            }
        }
        let content = try chapters.enumerated().map { index, chapter in
            let name = clean(chapter.child("title")?.text)
            return EPUBChapter(title: name.isEmpty ? "第 \(index + 1) 节" : name, body: try render(chapter), anchor: anchors[ObjectIdentifier(chapter)], headings: headings(chapter))
        }
        return EPUBContent(title: title.isEmpty ? fallbackTitle : title, author: authors, language: language.range(of: #"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$"#, options: .regularExpression) == nil ? "und" : language, chapters: content, resources: resources, cover: cover)
    }
    private static func validateSVG(_ bytes: Data) throws {
        let root = try FictionXML.parse(bytes)
        guard root.name == "svg", root.namespace == "http://www.w3.org/2000/svg" else { throw LibraryFailure.invalidFile }
        func walk(_ node: FictionNode) throws {
            guard !["script", "foreignobject", "iframe", "object", "embed", "animate", "animatetransform", "animatemotion", "set", "discard"].contains(node.name.lowercased()) else { throw LibraryFailure.invalidFile }
            for (key, value) in node.attributes {
                guard !(key.split(separator: ":").last?.lowercased().hasPrefix("on") ?? false), key.lowercased() != "xml:base" else { throw LibraryFailure.invalidFile }
                if key.split(separator: ":").last == "href", !value.hasPrefix("#") { throw LibraryFailure.invalidFile }
            }
            let css = node.attributes.values.joined(separator: " ") + (node.name == "style" ? node.text : "")
            guard !css.contains("\\"), css.range(of: "@import", options: .caseInsensitive) == nil, css.range(of: "expression(", options: .caseInsensitive) == nil else { throw LibraryFailure.invalidFile }
            let pattern = try NSRegularExpression(pattern: #"(?i)url\(\s*['\"]?([^)'\"]+)"#)
            let source = css as NSString
            guard pattern.matches(in: css, range: NSRange(location: 0, length: source.length)).allSatisfy({ source.substring(with: $0.range(at: 1)).hasPrefix("#") }) else { throw LibraryFailure.invalidFile }
            for child in node.children { try walk(child) }
        }
        try walk(root)
    }
}
