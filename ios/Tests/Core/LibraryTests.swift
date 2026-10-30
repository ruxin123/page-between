import XCTest
@testable import PageBetweenCore

final class LibraryTests: XCTestCase {
    func testImportRestartDeleteAndDuplicateRestoreKeepOriginalAndPosition() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let source = folder.appendingPathComponent("Original.txt")
        let bytes = Data("第一章 原创样本\n\nAn original paragraph.".utf8)
        try bytes.write(to: source)
        let root = folder.appendingPathComponent("Library")
        let repository = try LibraryRepository(root: root)
        var book = try await repository.importFile(source)
        book.locator = "{\"href\":\"chapter-1.xhtml\"}"
        book.progress = 0.4
        try await repository.update(book)
        try await repository.markDeleted(book.id, deleted: true)
        let hidden = await repository.books()
        XCTAssertTrue(hidden.isEmpty)
        let original = try await repository.file(book, name: book.originalName)
        XCTAssertEqual(try Data(contentsOf: original), bytes)
        let restarted = try LibraryRepository(root: root)
        let restored = try await restarted.importFile(source)
        XCTAssertEqual(restored.id, book.id)
        XCTAssertEqual(restored.locator, book.locator)
        XCTAssertEqual(restored.progress, 0.4)
        let all = await restarted.books(includingDeleted: true)
        XCTAssertEqual(all.count, 1)
        do { _ = try await restarted.file(book, name: "../../outside"); XCTFail("Path escape accepted") }
        catch { XCTAssertTrue(error is LibraryFailure) }
    }

    func testCorruptCatalogIsNotOverwritten() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let path = root.appendingPathComponent("library.json"), bytes = Data("invalid catalog".utf8)
        try bytes.write(to: path)
        XCTAssertThrowsError(try LibraryRepository(root: root))
        XCTAssertEqual(try Data(contentsOf: path), bytes)
    }

    func testConversationsPersistWithSourceAndSurviveBookRemoval() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("Original.txt"); try Data("Original content".utf8).write(to: source)
        let repository = try LibraryRepository(root: root.appendingPathComponent("Library"))
        let book = try await repository.importFile(source)
        var conversation = MobileConversation(book: book.id, quote: #"A formula $x^2$."#, locator: #"{"href":"chapter-1.xhtml"}"#)
        conversation.previewQuote = #"A formula $x^2$."#
        conversation.sourceObjects = [PDFSourceObject(page: 3, box: PDFBox(0.1,0.2,0.3,0.4), type: "equation", text: #"$x^2$"#)]
        conversation.turns = [MobileTurn(role: "user", content: "Explain"), MobileTurn(role: "assistant", content: #"Use $x^2$."#)]
        try await repository.saveConversation(conversation)
        try await repository.markDeleted(book.id, deleted: true)
        let restarted = try LibraryRepository(root: root.appendingPathComponent("Library"))
        try await restarted.markDeleted(book.id, deleted: false)
        let saved = try await restarted.conversations(book.id)
        XCTAssertEqual(saved, [conversation])
        var interrupted = conversation
        interrupted.turns[1].status = "generating"
        try await restarted.saveConversation(interrupted)
        let recovered = try await LibraryRepository(root: root.appendingPathComponent("Library")).conversations(book.id)
        XCTAssertEqual(recovered.first?.turns[1].status, "stopped")
        XCTAssertEqual(recovered.first?.turns[1].content, conversation.turns[1].content)
        XCTAssertEqual(recovered.first?.sourceObjects, conversation.sourceObjects)
    }

    func testChaptersAndLongNovelPreserveEveryCharacter() {
        let chapters = TextChapters.parse("第一回 开篇\n\n甲乙\n\n第二回 归来\n\n丙丁")
        XCTAssertEqual(chapters.map(\.title), ["第一回 开篇", "第二回 归来"])
        XCTAssertTrue(chapters[1].body.contains("丙丁"))
        let long = String(repeating: "Unstructured novel 🪶。", count: 5000)
        let split = TextChapters.parse(long)
        XCTAssertGreaterThan(split.count, 2)
        XCTAssertEqual(split.map(\.body).joined(), long)
        XCTAssertTrue(split.allSatisfy { ($0.body as NSString).length <= 30000 })
    }

    func testLocationWritesPreserveBookmarksAndFailedImportCleanupIsLimited() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("Original.txt"); try Data("Original content".utf8).write(to: source)
        let repository = try LibraryRepository(root: root.appendingPathComponent("Library"))
        let book = try await repository.importFile(source)
        try await repository.toggleBookmark(book.id, title: "My mark", locator: "bookmark")
        try await repository.saveLocation(book.id, locator: "position", progress: 0.6, chapter: "Chapter")
        let currentBooks = await repository.books()
        let saved = try XCTUnwrap(currentBooks.first)
        XCTAssertEqual(saved.bookmarks.first?.locator, "bookmark")
        XCTAssertEqual(saved.progress, 0.6)
        do { try await repository.discardFailedImport(book.id); XCTFail("Existing reading data must not be discarded") } catch {}
        let invalid = root.appendingPathComponent("Invalid.pdf"); try Data("not a PDF".utf8).write(to: invalid)
        let failed = try await repository.importFile(invalid)
        let path = try await repository.file(failed)
        try await repository.discardFailedImport(failed.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
        let remaining = await repository.books()
        XCTAssertEqual(remaining.map(\.id), [book.id])
    }

    func testUTF16AndXMLControls() throws {
        let original = "第一章 开始\n原文 🪶"
        XCTAssertEqual(try TextChapters.decode(try XCTUnwrap(original.data(using: .utf16))), original)
        XCTAssertEqual(TextChapters.escape("< & \u{0}\u{1}\n🪶"), "&lt; &amp; ��\n🪶")
    }
}
