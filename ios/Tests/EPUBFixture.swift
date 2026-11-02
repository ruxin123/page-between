import Foundation

@main struct EPUBFixture {
    static func main() async throws {
        let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let original = folder.appendingPathComponent("original.txt"), output = folder.appendingPathComponent("original.epub")
        let bytes = Data("第一章 原创样本\n\nAn original paragraph with <angles> & symbols 🪶.\n\n第二章 继续阅读\n\nThis is another original paragraph.".utf8)
        try bytes.write(to: original)
        try await TextEPUB.create(original: original, title: "Original mobile reading sample", destination: output)
        try await TextEPUB.create(original: original, title: "Original mobile reading sample", destination: output)
        try await TextEPUB.create(original: original, title: "Original without indexing", destination: folder.appendingPathComponent("unparsed.epub"), parseEnabled: false)
        guard try Data(contentsOf: original) == bytes else { throw LibraryFailure.invalidFile }
        let svg = ##"<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" fill="#537d68"/></svg>"##
        let image = Data(svg.utf8).base64EncodedString()
        let xml = ##"<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Original illustrated sample</book-title><author><first-name>Synthetic</first-name><last-name>Reader</last-name></author><lang>en</lang><coverpage><image l:href="#picture"/></coverpage></title-info></description><body><section id="first"><title><p>第一章 原创图书</p></title><p>An original illustrated paragraph 🪶.</p><image l:href="#picture"/><p><a l:href="#second">Read the second chapter</a></p><table><tr><th>x</th><th>f(x)</th></tr><tr><td>1</td><td>2</td></tr></table><section><title><p>Nested section</p></title><p>Original nested text.</p></section></section><section id="second"><title><p>Second chapter</p></title><p>Second original illustrated paragraph.</p><p><a l:href="#first">Return to the first chapter</a></p></section></body><binary id="picture" content-type="image/svg+xml">"## + image + "</binary></FictionBook>"
        let source = folder.appendingPathComponent("original.fb2"), data = Data(xml.utf8)
        try data.write(to: source)
        try await TextEPUB.create(content: FB2Parser.parse(data, fallbackTitle: "Fallback"), destination: folder.appendingPathComponent("fb2.epub"))
        guard try Data(contentsOf: source) == data else { throw LibraryFailure.invalidFile }
    }
}
