import XCTest
@testable import PageBetweenCore

final class MobileBackupTests: XCTestCase {
    func testBackupRestoreKeepsRecordsAndExcludesCredentials() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let source = folder.appendingPathComponent("Original.txt")
        try Data("Original local reading content.".utf8).write(to: source)
        let root = folder.appendingPathComponent("Library"), repository = try LibraryRepository(root: root)
        let book = try await repository.importFile(source)
        let locator = #"{"href":"chapter.xhtml","locations":{"progression":0.4}}"#
        try await repository.saveLocation(book.id, locator: locator, progress: 0.4, chapter: "Chapter")
        try await repository.toggleBookmark(book.id, title: "Bookmark", locator: locator)
        let appearance = ReadingAppearance(fontScale: 110, lineHeight: 1.8, pageMargins: 1, fontFamily: "Georgia", theme: "night", scroll: false)
        try await repository.saveAppearance(book.id, value: appearance)
        var excerpt = SavedExcerpt(quote: #"Original $x^2$"#, markdown: nil, locator: locator, chapter: "Chapter")
        excerpt.note = "A private note"; excerpt.answer = "A saved answer"
        try await repository.saveExcerpt(book.id, excerpt: excerpt)
        var conversation = MobileConversation(book: book.id, quote: "Original", locator: locator)
        conversation.turns = [MobileTurn(role: "user", content: "Why?"), MobileTurn(role: "assistant", content: "Because.")]
        try await repository.saveConversation(conversation)
        try await repository.markDeleted(book.id, deleted: true)
        let secret = root.appendingPathComponent("credentials.json")
        try Data("synthetic-local-key".utf8).write(to: secret)
        let staging = folder.appendingPathComponent("staging")
        let manifest = try await repository.backupSnapshot(to: staging)
        XCTAssertFalse(manifest.files.contains { $0.path.contains("credentials") })
        let exported = try manifest.catalog(at: staging)
        XCTAssertEqual(exported.books.first?.excerpts, [excerpt])
        XCTAssertNotNil(exported.books.first?.deletedAt)
        try await repository.markDeleted(book.id, deleted: false)
        try await repository.saveLocation(book.id, locator: locator, progress: 0.9, chapter: "Changed")
        try Data("current-local-key".utf8).write(to: secret)
        try await repository.restoreBackup(manifest, from: staging)
        let reopened = try LibraryRepository(root: root), books = await reopened.books(includingDeleted: true)
        XCTAssertEqual(books.first?.progress, 0.4)
        XCTAssertEqual(books.first?.appearance, appearance)
        XCTAssertEqual(books.first?.bookmarks.count, 1)
        let conversations = try await reopened.conversations(book.id)
        XCTAssertEqual(conversations, [conversation])
        XCTAssertEqual(try String(contentsOf: secret), "current-local-key")
        let restoredOriginal = try await reopened.file(book, name: book.originalName)
        XCTAssertEqual(try Data(contentsOf: restoredOriginal), try Data(contentsOf: source))
    }
    func testTamperedOrEscapingBackupCannotChangeLibrary() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let source = folder.appendingPathComponent("Original.txt"); try Data("Original".utf8).write(to: source)
        let root = folder.appendingPathComponent("Library"), repository = try LibraryRepository(root: root)
        let book = try await repository.importFile(source), staging = folder.appendingPathComponent("snapshot")
        let manifest = try await repository.backupSnapshot(to: staging)
        let before = try Data(contentsOf: root.appendingPathComponent("library.json"))
        try Data("tampered".utf8).write(to: staging.appendingPathComponent("books/" + book.id.uuidString + "/" + book.originalName))
        do { try await repository.restoreBackup(manifest, from: staging); XCTFail("Tampering accepted") } catch { }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("library.json")), before)
        for path in ["credentials.json", "../library.json", "books/../credentials.json", "books/" + book.id.uuidString + "/../../credentials.json", "books/" + book.id.uuidString + "/credentials.json", "books/" + book.id.uuidString + "/link/../file"] {
            XCTAssertFalse(MobileBackupManifest.validPath(path), path)
        }
        let link = try await repository.file(book, name: "leak.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        do { _ = try await repository.backupSnapshot(to: folder.appendingPathComponent("bad-snapshot")); XCTFail("Symlink accepted") } catch { }
    }
}
