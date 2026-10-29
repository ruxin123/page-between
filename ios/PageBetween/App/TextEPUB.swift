import Foundation
import ReadiumZIPFoundation

enum TextEPUB {
    static func create(original: URL, title: String, destination: URL) async throws {
        let size = try original.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 50 * 1024 * 1024 else { throw LibraryFailure.tooLarge }
        let chapters = TextChapters.parse(try TextChapters.decode(Data(contentsOf: original)))
        let folder = destination.deletingLastPathComponent().appendingPathComponent(".epub-" + UUID().uuidString, isDirectory: true)
        let manager = FileManager.default
        try manager.createDirectory(at: folder.appendingPathComponent("META-INF"), withIntermediateDirectories: true)
        try manager.createDirectory(at: folder.appendingPathComponent("EPUB"), withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: folder) }
        func write(_ path: String, _ text: String) throws { try Data(text.utf8).write(to: folder.appendingPathComponent(path)) }
        try write("mimetype", "application/epub+zip")
        try write("META-INF/container.xml", #"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#)
        var manifest = "", spine = "", links = ""
        for (index, chapter) in chapters.enumerated() {
            let name = "chapter-\(index).xhtml", escapedTitle = TextChapters.escape(chapter.title)
            let body = chapter.body.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { "<p>" + TextChapters.escape($0) + "</p>" }.joined()
            try write("EPUB/" + name, #"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="zh"><head><title>"# + escapedTitle + #"</title><meta charset="utf-8"/><style>body{line-height:1.85}p{text-indent:2em}h1{font-size:1.4em}</style></head><body><h1>"# + escapedTitle + "</h1>" + body + "</body></html>")
            manifest += "<item id=\"c\(index)\" href=\"\(name)\" media-type=\"application/xhtml+xml\"/>"
            spine += "<itemref idref=\"c\(index)\"/>"
            links += "<li><a href=\"\(name)\">\(escapedTitle)</a></li>"
        }
        try write("EPUB/nav.xhtml", #"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh"><head><title>目录</title></head><body><nav epub:type="toc"><ol>"# + links + "</ol></nav></body></html>")
        let date = ISO8601DateFormatter().string(from: Date())
        try write("EPUB/package.opf", #"<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:"# + UUID().uuidString + "</dc:identifier><dc:title>" + TextChapters.escape(title) + #"</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">"# + date + #"</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>"# + manifest + "</manifest><spine>" + spine + "</spine></package>")
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".reading-" + UUID().uuidString + ".epub")
        defer { try? manager.removeItem(at: temporary) }
        let archive = try await Archive(url: temporary, accessMode: .create)
        try await archive.addEntry(with: "mimetype", relativeTo: folder, compressionMethod: .none)
        for path in ["META-INF/container.xml", "EPUB/package.opf", "EPUB/nav.xhtml"] + chapters.indices.map({ "EPUB/chapter-\($0).xhtml" }) {
            try await archive.addEntry(with: path, relativeTo: folder, compressionMethod: .deflate)
        }
        if manager.fileExists(atPath: destination.path) { _ = try manager.replaceItemAt(destination, withItemAt: temporary) }
        else { try manager.moveItem(at: temporary, to: destination) }
    }
}
