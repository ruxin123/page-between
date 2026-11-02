import Foundation
import ReadiumZIPFoundation

enum TextEPUB {
    static func create(original: URL, title: String, destination: URL, parseEnabled: Bool = true) async throws {
        let size = try original.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 50 * 1024 * 1024 else { throw LibraryFailure.tooLarge }
        let chapters = TextChapters.parse(try TextChapters.decode(Data(contentsOf: original)), detectHeadings: parseEnabled)
        let content = EPUBContent(title: title, language: "zh", chapters: chapters.map { chapter in
            let body = chapter.body.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { "<p>" + TextChapters.escape($0) + "</p>" }.joined()
            let heading = chapter.title == "全文" ? "" : "<h1>" + TextChapters.escape(chapter.title) + "</h1>"
            return EPUBChapter(title: chapter.title, body: heading + body)
        })
        try await create(content: content, destination: destination)
    }
    static func create(content: EPUBContent, destination: URL) async throws {
        guard !content.chapters.isEmpty, content.chapters.count <= 10000, content.resources.count <= 1000,
              content.resources.reduce(0, { $0 + $1.data.count }) <= 64 * 1024 * 1024,
              Set(content.resources.map(\.name)).count == content.resources.count,
              content.resources.allSatisfy({ $0.name.range(of: #"^images/[A-Za-z0-9_-]+\.(?:png|jpg|gif|svg)$"#, options: .regularExpression) != nil }),
              content.cover == nil || content.resources.contains(where: { $0.name == content.cover }) else { throw LibraryFailure.invalidFile }
        let folder = destination.deletingLastPathComponent().appendingPathComponent(".epub-" + UUID().uuidString, isDirectory: true)
        let manager = FileManager.default
        try manager.createDirectory(at: folder.appendingPathComponent("META-INF"), withIntermediateDirectories: true)
        try manager.createDirectory(at: folder.appendingPathComponent("EPUB/images"), withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: folder) }
        func write(_ path: String, _ text: String) throws { try Data(text.utf8).write(to: folder.appendingPathComponent(path)) }
        try write("mimetype", "application/epub+zip")
        try write("META-INF/container.xml", #"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#)
        var manifest = "", spine = "", links = ""
        func navigation(_ headings: [EPUBHeading], file: String) -> String {
            guard !headings.isEmpty else { return "" }
            return "<ol>" + headings.map { "<li><a href=\"" + file + "#" + TextChapters.escape($0.anchor) + "\">" + TextChapters.escape($0.title) + "</a>" + navigation($0.children, file: file) + "</li>" }.joined() + "</ol>"
        }
        let language = TextChapters.escape(content.language)
        for (index, chapter) in content.chapters.enumerated() {
            let name = "chapter-\(index).xhtml", title = TextChapters.escape(chapter.title)
            try write("EPUB/" + name, #"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang=""# + language + #""><head><title>"# + title + #"</title><meta charset="utf-8"/><style>body{line-height:1.85}p{text-indent:2em}h1{font-size:1.4em}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{padding:.3em .6em;border:1px solid #888}code,pre{white-space:pre-wrap}</style></head><body>"# + chapter.body + "</body></html>")
            manifest += "<item id=\"c\(index)\" href=\"\(name)\" media-type=\"application/xhtml+xml\"/>"
            spine += "<itemref idref=\"c\(index)\"/>"
            let anchor = chapter.anchor.map { "#" + TextChapters.escape($0) } ?? ""
            links += "<li><a href=\"\(name)\(anchor)\">\(title)</a>" + navigation(chapter.headings, file: name) + "</li>"
        }
        for (index, resource) in content.resources.enumerated() {
            try resource.data.write(to: folder.appendingPathComponent("EPUB/" + resource.name))
            manifest += "<item id=\"image-\(index)\" href=\"\(resource.name)\" media-type=\"\(TextChapters.escape(resource.mediaType))\"\(resource.name == content.cover ? " properties=\"cover-image\"" : "")/>"
        }
        try write("EPUB/nav.xhtml", #"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang=""# + language + #""><head><title>目录</title></head><body><nav epub:type="toc"><ol>"# + links + "</ol></nav></body></html>")
        let date = ISO8601DateFormatter().string(from: Date())
        let author = content.author.isEmpty ? "" : "<dc:creator>" + TextChapters.escape(content.author) + "</dc:creator>"
        try write("EPUB/package.opf", #"<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:"# + UUID().uuidString + "</dc:identifier><dc:title>" + TextChapters.escape(content.title) + "</dc:title>" + author + "<dc:language>" + language + #"</dc:language><meta property="dcterms:modified">"# + date + #"</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>"# + manifest + "</manifest><spine>" + spine + "</spine></package>")
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".reading-" + UUID().uuidString + ".epub")
        defer { try? manager.removeItem(at: temporary) }
        let archive = try await Archive(url: temporary, accessMode: .create)
        try await archive.addEntry(with: "mimetype", relativeTo: folder, compressionMethod: .none)
        for path in ["META-INF/container.xml", "EPUB/package.opf", "EPUB/nav.xhtml"] + content.chapters.indices.map({ "EPUB/chapter-\($0).xhtml" }) + content.resources.map({ "EPUB/" + $0.name }) {
            try await archive.addEntry(with: path, relativeTo: folder, compressionMethod: .deflate)
        }
        if manager.fileExists(atPath: destination.path) { _ = try manager.replaceItemAt(destination, withItemAt: temporary) }
        else { try manager.moveItem(at: temporary, to: destination) }
    }
}
