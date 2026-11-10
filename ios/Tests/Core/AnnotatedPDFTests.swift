#if canImport(PDFKit)
import XCTest
import PDFKit
@testable import PageBetweenCore

final class AnnotatedPDFTests: XCTestCase {
    func testOriginalPreservedWithRotatedCropsHighlightsAndLegacyNotes() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let original = folder.appendingPathComponent("original.pdf")
        var media = CGRect(x: 0, y: 0, width: 600, height: 800)
        let context = try XCTUnwrap(CGContext(original as CFURL, mediaBox: &media, nil))
        for _ in 0..<4 { context.beginPDFPage(nil); context.setFillColor(gray: 0, alpha: 1); context.fill(CGRect(x: 80, y: 500, width: 300, height: 20)); context.endPDFPage() }
        context.closePDF()
        let source = try XCTUnwrap(PDFDocument(url: original))
        for index in 0..<4 { let page = try XCTUnwrap(source.page(at: index)); page.setBounds(CGRect(x: 40, y: 100, width: 520, height: 600), for: .cropBox); page.rotation = index * 90 }
        let old = PDFAnnotation(bounds: CGRect(x: 50, y: 150, width: 20, height: 20), forType: .text, withProperties: nil)
        old.contents = "Existing note"; source.page(at: 0)!.addAnnotation(old)
        XCTAssertTrue(source.write(to: original))
        let before = try Data(contentsOf: original)
        let locator = #"{"locations":{"position":2,"fragments":["y=0.4"]}}"#
        var excerpt = SavedExcerpt(quote: "Original $x^2$", markdown: nil, locator: locator, chapter: "Original chapter", rects: (1...4).map { PDFSelectionRect(page: $0, box: PDFBox(0.2, 0.2, 0.6, 0.24)) })
        excerpt.note = "中文笔记"
        let legacy = SavedExcerpt(quote: "Legacy quote", markdown: nil, locator: locator, chapter: "Original")
        var removed = excerpt; removed.deletedAt = Date()
        let result = try XCTUnwrap(PDFDocument(data: AnnotatedPDF.data(original: original, excerpts: [excerpt, legacy, removed])))
        XCTAssertEqual(try Data(contentsOf: original), before)
        XCTAssertEqual(result.pageCount, 4)
        XCTAssertTrue(result.page(at: 0)!.annotations.contains { $0.contents == "Existing note" })
        for index in 0..<4 {
            let page = try XCTUnwrap(result.page(at: index))
            XCTAssertEqual(page.rotation, index * 90)
            let marks = page.annotations.filter { $0.type == "Highlight" }
            XCTAssertEqual(marks.count, 1)
            let annotation = try XCTUnwrap(marks.first)
            XCTAssertEqual(annotation.contents, "Original $x^2$\n\n笔记\n中文笔记")
            let expected = [(144.0, 580.0), (144, 220), (456, 220), (456, 580)][index]
            let point = try AnnotatedPDF.point(0.2, 0.2, on: page)
            XCTAssertEqual(point.x, expected.0, accuracy: 0.01)
            XCTAssertEqual(point.y, expected.1, accuracy: 0.01)
            XCTAssertEqual(annotation.quadrilateralPoints?.count, 4)
        }
        XCTAssertTrue(result.page(at: 1)!.annotations.contains { $0.type == "Text" && $0.contents == "Legacy quote" })
        var invalid = excerpt; invalid.rects = [PDFSelectionRect(page: 5, box: PDFBox(0, 0, 1, 1))]
        XCTAssertThrowsError(try AnnotatedPDF.data(original: original, excerpts: [invalid]))
        let oldData = try JSONEncoder().encode(legacy)
        XCTAssertNil(try JSONDecoder().decode(SavedExcerpt.self, from: oldData).rects)
    }
}
#endif
