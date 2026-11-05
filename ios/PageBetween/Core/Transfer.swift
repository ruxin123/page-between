import Foundation
import CryptoKit

public struct TransferPosition: Codable, Sendable {
    public var index: Int
    public var progress: Double
    public var chapterFraction: Double
    public var pdfY: Double
    public init(index: Int = 1, progress: Double = 0, chapterFraction: Double = 0, pdfY: Double = 0) { self.index = index; self.progress = progress; self.chapterFraction = chapterFraction; self.pdfY = pdfY }
    public func validate() throws {
        guard (1...1000000).contains(index), [progress, chapterFraction, pdfY].allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { throw LibraryFailure.invalidFile }
    }
}
public struct TransferBookmark: Codable, Sendable {
    public var title: String
    public var position: TransferPosition
    public init(title: String, position: TransferPosition) { self.title = title; self.position = position }
}
public struct TransferBook: Codable, Sendable {
    public var title: String
    public var author: String
    public var file: String
    public var sha256: String
    public var position: TransferPosition
    public var bookmarks: [TransferBookmark]
    public init(title: String, author: String, file: String, sha256: String, position: TransferPosition, bookmarks: [TransferBookmark]) { self.title = title; self.author = author; self.file = file; self.sha256 = sha256; self.position = position; self.bookmarks = bookmarks }
}
public struct TransferManifest: Codable, Sendable {
    public var schema = 1
    public var kind = "page-between-transfer"
    public var books: [TransferBook]
    public init(books: [TransferBook]) { self.books = books }
    public func validate() throws {
        guard schema == 1, kind == "page-between-transfer", books.count <= 5000, Set(books.map(\.file)).count == books.count else { throw LibraryFailure.invalidFile }
        for book in books {
            guard book.title.count <= 2000, book.author.count <= 2000, book.sha256.range(of: "^[0-9a-f]{64}\\z", options: .regularExpression) != nil,
                  book.file.range(of: "^books/[0-9a-f]{64}\\.(epub|pdf|txt|fb2|cbz)\\z", options: .regularExpression) != nil,
                  URL(fileURLWithPath: book.file).deletingPathExtension().lastPathComponent == book.sha256, book.bookmarks.count <= 10000 else { throw LibraryFailure.invalidFile }
            try book.position.validate()
            for mark in book.bookmarks { guard mark.title.count <= 2000 else { throw LibraryFailure.invalidFile }; try mark.position.validate() }
        }
    }
    public static func hash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
