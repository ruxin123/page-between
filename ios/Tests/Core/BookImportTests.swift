import XCTest
@testable import PageBetweenCore

final class BookImportTests: XCTestCase {
    func testDefaultParsingAndDisabledTXTKeepEverySourceCharacter() {
        for name in ["original.pdf", "original.PDF", "original.txt"] { XCTAssertTrue(BookImport(URL(fileURLWithPath: name)).parseEnabled) }
        for name in ["original.epub", "original.cbz", "original.fb2"] { XCTAssertFalse(BookImport(URL(fileURLWithPath: name)).parseEnabled) }
        let original = "第一章 开始\n\nA source paragraph 🪶.\n第二章 继续\n\nAnother source paragraph."
        XCTAssertEqual(TextChapters.parse(original).map(\.title), ["第一章 开始", "第二章 继续"])
        let unparsed = TextChapters.parse(original, detectHeadings: false)
        XCTAssertEqual(unparsed.count, 1)
        XCTAssertEqual(unparsed.first?.body, original)
        let long = String(repeating: original, count: 1000)
        XCTAssertEqual(TextChapters.parse(long, detectHeadings: false).map(\.body).joined(), long)
    }
    func testChoicePersistsAndDuplicateImportKeepsExistingSettings() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("Original.txt"), bytes = Data("第一章 开始\nOriginal source.".utf8)
        try bytes.write(to: source)
        let repository = try LibraryRepository(root: root.appendingPathComponent("Library"))
        let imported = try await repository.importFile(source, parseEnabled: false)
        XCTAssertFalse(imported.shouldPrepare)
        try await repository.markDeleted(imported.id, deleted: true)
        let reopened = try LibraryRepository(root: root.appendingPathComponent("Library"))
        let restored = try await reopened.importFile(source, parseEnabled: true)
        XCTAssertEqual(restored.id, imported.id)
        XCTAssertFalse(restored.shouldPrepare)
        XCTAssertNil(restored.deletedAt)
        let original = try await reopened.file(restored, name: restored.originalName)
        XCTAssertEqual(try Data(contentsOf: original), bytes)
    }
}
