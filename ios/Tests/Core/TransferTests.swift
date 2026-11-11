import XCTest
@testable import PageBetweenCore
final class TransferTests: XCTestCase {
    func testPortablePositionBounds() throws {
        try TransferPosition(index: 4, progress: 0.4, chapterFraction: 0.3, pdfY: 0.2).validate()
        XCTAssertThrowsError(try TransferPosition(index: 0).validate())
        XCTAssertThrowsError(try TransferPosition(progress: .nan).validate())
        XCTAssertThrowsError(try TransferPosition(chapterFraction: 1.1).validate())
    }
    func testRejectsPathsAndDuplicateHashes() throws {
        let hash = String(repeating: "a", count: 64)
        var book = TransferBook(title: "Original", author: "Author", file: "books/" + hash + ".txt", sha256: hash, position: TransferPosition(), bookmarks: [])
        try TransferManifest(books: [book]).validate()
        XCTAssertThrowsError(try TransferManifest(books: [book, book]).validate())
        book.file = "../outside.txt"
        XCTAssertThrowsError(try TransferManifest(books: [book]).validate())
    }
    func testRepeatedRecordMergePreservesLocalChanges() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let source = folder.appendingPathComponent("Original.txt")
        try Data("Original reading content".utf8).write(to: source)
        let repository = try LibraryRepository(root: folder.appendingPathComponent("library"))
        let book = try await repository.importFile(source), locator = #"{"href":"chapter.xhtml","type":"application/xhtml+xml"}"#
        var record = SavedExcerpt(quote: #"Original $x^2$"#, markdown: nil, locator: locator, chapter: "Chapter 1")
        record.note = "Incoming note"
        var conversation = MobileConversation(book: book.id, quote: record.quote, locator: locator)
        conversation.turns = [MobileTurn(role: "user", content: "Original question")]
        var incoming = ImportedReadingRecords()
        incoming.excerpts = [record]; incoming.conversations = [conversation]
        incoming.appearance = ReadingAppearance(fontScale: 110, lineHeight: 1.85, pageMargins: 1, fontFamily: "Georgia", theme: "night", scroll: false)
        let imported = try await repository.mergeReadingRecords(book.id, incoming: incoming)
        XCTAssertEqual(imported, 2)
        record.note = "Kept local edit"; record.deletedAt = Date()
        try await repository.saveExcerpt(book.id, excerpt: record)
        let localAppearance = ReadingAppearance(fontScale: 130, lineHeight: 1.6, pageMargins: 1, fontFamily: "PingFang SC", theme: "paper", scroll: true)
        try await repository.saveAppearance(book.id, value: localAppearance)
        try await repository.saveLocation(book.id, locator: locator, progress: 0.7, chapter: "Chapter 1")
        conversation.turns.append(MobileTurn(role: "assistant", content: "Kept local answer"))
        try await repository.saveConversation(conversation)
        let repeated = try await repository.mergeReadingRecords(book.id, incoming: incoming)
        XCTAssertEqual(repeated, 0)
        let saved = await repository.books().first
        XCTAssertEqual(saved?.excerpts, [record]); XCTAssertEqual(saved?.progress, 0.7); XCTAssertEqual(saved?.appearance, localAppearance)
        let conversations = try await repository.conversations(book.id)
        XCTAssertEqual(conversations, [conversation])
    }

}
