import XCTest
@testable import PageBetweenCore

final class PDFPreparationTests: XCTestCase {
    func testRangesAndGeometryRejectInvalidCoordinates() throws {
        XCTAssertEqual(try PDFPageRange.parse("3-5,1，5", total: 8), [1,3,4,5])
        for value in ["0", "3-1", "1-99", "1,,2", "a", "-1"] { XCTAssertThrowsError(try PDFPageRange.parse(value, total: 8)) }
        XCTAssertFalse(PDFBox(0, 0, .infinity, 1).isValid)
        XCTAssertFalse(PDFBox(0.6, 0, 0.3, 1).isValid)
        XCTAssertTrue(PDFBox(0,0,1,1).overlaps(PDFBox(0.3,0.3,0.5,0.5)))
    }
    func testOCRAndMinerUResultsMergeAndResumeWithoutErasingEachOther() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("original.pdf"); try Data("Original PDF test bytes".utf8).write(to: source)
        let repo = try LibraryRepository(root: root.appendingPathComponent("Library"))
        let book = try await repo.importFile(source)
        var ocr = PDFPreparedPage(page: 4, sourceHash: book.sourceHash, width: 600, height: 800)
        ocr.words = [PDFWord(text: "Original", box: PDFBox(0.1,0.1,0.4,0.2), confidence: 0.9, line: 0)]; ocr.ocrCompleted = true
        try await repo.savePDFPage(book.id, page: ocr)
        var cloud = PDFPreparedPage(page: 4, sourceHash: book.sourceHash, width: 600, height: 800)
        cloud.blocks = [PDFContentBlock(id: "p4-b0", type: "equation", text: #"$$\sigma\in S_n$$"#, box: PDFBox(0.1,0.3,0.6,0.4), order: 0)]; cloud.mineruCompleted = true
        try await repo.savePDFPage(book.id, page: cloud)
        var task = PDFPreparationTask(book: book.id, sourceHash: book.sourceHash, engine: "ocr", pages: [1,2,3,4])
        task.completed = [4]; task.state = "running"; try await repo.savePDFTask(task)
        let restarted = try LibraryRepository(root: root.appendingPathComponent("Library"))
        let restored = try await restarted.pdfPage(book.id, page: 4)
        XCTAssertEqual(restored?.words, ocr.words)
        XCTAssertEqual(restored?.blocks, cloud.blocks)
        XCTAssertEqual(restored?.text, cloud.blocks[0].text)
        let resumed = try await restarted.pdfTask(book.id, engine: "ocr")
        XCTAssertEqual(resumed?.state, "paused"); XCTAssertEqual(resumed?.completed, [4])
        cloud.sourceHash = String(repeating: "0", count: 64)
        do { try await repo.savePDFPage(book.id, page: cloud); XCTFail("Changed source accepted") } catch {}
    }
}
