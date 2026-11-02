import XCTest
@testable import PageBetweenCore

final class FB2Tests: XCTestCase {
    private let diagram = ##"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40"><rect width="80" height="40" fill="#537d68"/></svg>"##
    private func book(image: String? = nil) -> Data {
        let encoded = Data((image ?? diagram).utf8).base64EncodedString()
        return Data((##"<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Original &amp; Guide</book-title><author><first-name>Casey</first-name><last-name>Reader</last-name></author><lang>en</lang><coverpage><image l:href="#picture"/></coverpage></title-info></description><body><section id="start"><title><p>第一章 <emphasis>开篇</emphasis></p></title><p>Original source Ω 🪶 &amp; x<sup>2</sup>.</p><p>See <a l:href="#note">note one</a>.</p><image l:href="#picture"/><table><tr><th colspan="2">Original table</th></tr><tr><td>x</td><td>1</td></tr></table><section id="nested"><title><p>A nested section</p></title><p>Nested original paragraph.</p></section><p><a l:href="javascript:alert(1)">Untrusted link text</a></p></section><section id="second"><title><p>Second chapter</p></title><p>Another original paragraph.</p></section></body><body name="notes"><section id="note"><title><p>Note one</p></title><p>Original note.</p></section></body><binary id="picture" content-type="image/svg+xml">"## + encoded + "</binary></FictionBook>").utf8)
    }
    func testMetadataNestedTOCImagesTablesAndCrossChapterLinks() throws {
        let result = try FB2Parser.parse(book(), fallbackTitle: "Fallback")
        XCTAssertEqual(result.title, "Original & Guide")
        XCTAssertEqual(result.author, "Casey Reader")
        XCTAssertEqual(result.language, "en")
        XCTAssertEqual(result.chapters.map(\.title), ["第一章 开篇", "Second chapter", "Note one"])
        XCTAssertEqual(result.chapters[0].headings.map(\.title), ["A nested section"])
        XCTAssertEqual(result.resources.first?.data, Data(diagram.utf8))
        XCTAssertEqual(result.cover, result.resources.first?.name)
        let body = result.chapters[0].body
        XCTAssertTrue(body.contains("Original source Ω 🪶 &amp; x<sup>2</sup>"))
        XCTAssertTrue(body.contains("<h1><span>第一章 <em>开篇</em></span></h1>"))
        XCTAssertFalse(body.contains("<h1><p>"))
        XCTAssertTrue(body.contains("colspan=\"2\""))
        XCTAssertTrue(body.contains("chapter-2.xhtml#" + result.chapters[2].anchor!))
        XCTAssertTrue(body.contains("Untrusted link text")); XCTAssertFalse(body.contains("javascript:"))
    }
    func testInvalidAndActiveContentIsRejectedWithoutExternalLoading() {
        for svg in [
            ##"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"##,
            ##"<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.org/image"/></svg>"##,
            ##"<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.org/image)"/></svg>"##,
            ##"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>"##,
            ##"<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://example.org/"/>"##,
            ##"<svg xmlns="http://www.w3.org/2000/svg"><style>@import 'https://example.org/style';</style></svg>"##,
            ##"<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///synthetic">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>"##
        ] { XCTAssertThrowsError(try FB2Parser.parse(book(image: svg), fallbackTitle: "Fallback")) }
        let original = String(decoding: book(), as: UTF8.self)
        for invalid in [original.replacingOccurrences(of: "id=\"second\"", with: "id=\"start\""), original.replacingOccurrences(of: "#note\"", with: "#missing\""), "<not-fiction/>" ] {
            XCTAssertThrowsError(try FB2Parser.parse(Data(invalid.utf8), fallbackTitle: "Fallback"))
        }
    }
    func testDeepDocumentsAndMalformedXMLDoNotProducePartialBooks() {
        let deep = "<FictionBook><description><title-info/></description><body>" + String(repeating: "<section>", count: 150) + "<p>Original</p>" + String(repeating: "</section>", count: 150) + "</body></FictionBook>"
        XCTAssertThrowsError(try FB2Parser.parse(Data(deep.utf8), fallbackTitle: "Fallback"))
        XCTAssertThrowsError(try FB2Parser.parse(Data("<FictionBook><body>broken".utf8), fallbackTitle: "Fallback"))
    }
}
