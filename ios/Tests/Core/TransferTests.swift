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
}
