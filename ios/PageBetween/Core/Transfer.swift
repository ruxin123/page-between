import Foundation
import CryptoKit

public struct TransferPosition: Codable, Equatable, Sendable {
    public var index: Int
    public var progress: Double
    public var chapterFraction: Double
    public var pdfY: Double
    public var endIndex: Int?
    public var sourceOffset: Int?
    public var href: String?
    public var nativeMac: String?
    public var readium: String?
    public init(index: Int = 1, progress: Double = 0, chapterFraction: Double = 0, pdfY: Double = 0) { self.index = index; self.progress = progress; self.chapterFraction = chapterFraction; self.pdfY = pdfY }
    public func validate() throws {
        guard (1...1000000).contains(index), [progress, chapterFraction, pdfY].allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { throw LibraryFailure.invalidFile }
        guard endIndex.map({ (index...1000000).contains($0) }) != false, sourceOffset.map({ (0...300000000).contains($0) }) != false,
              (href?.utf8.count ?? 0) <= 2000, (nativeMac?.utf8.count ?? 0) <= 6000, (readium?.utf8.count ?? 0) <= 64000 else { throw LibraryFailure.invalidFile }
        for raw in [nativeMac, readium].compactMap({ $0 }) { guard (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) is [String: Any] else { throw LibraryFailure.invalidFile } }
    }
}
public struct TransferBookmark: Codable, Sendable {
    public var title: String
    public var position: TransferPosition
    public var id: String?
    public var createdAt: Double?
    public init(title: String, position: TransferPosition) { self.title = title; self.position = position }
}
public struct TransferBook: Codable, Sendable {
    public var title: String
    public var author: String
    public var file: String
    public var sha256: String
    public var position: TransferPosition
    public var bookmarks: [TransferBookmark]
    public var records: TransferFile?
    public var recordsData: TransferRecords? = nil
    enum CodingKeys: String, CodingKey { case title, author, file, sha256, position, bookmarks, records }
    public init(title: String, author: String, file: String, sha256: String, position: TransferPosition, bookmarks: [TransferBookmark]) { self.title = title; self.author = author; self.file = file; self.sha256 = sha256; self.position = position; self.bookmarks = bookmarks }
}
public struct TransferManifest: Codable, Sendable {
    public static let maxRecordBytes = 64 * 1024 * 1024
    public var schema = 2
    public var kind = "page-between-transfer"
    public var books: [TransferBook]
    public var images: [TransferFile]?
    public init(books: [TransferBook]) { self.books = books }
    public func validate() throws {
        guard [1, 2].contains(schema), kind == "page-between-transfer", books.count <= 5000, Set(books.map(\.file)).count == books.count else { throw LibraryFailure.invalidFile }
        guard (images?.count ?? 0) <= 50000, Set(images?.map(\.file) ?? []).count == (images?.count ?? 0) else { throw LibraryFailure.invalidFile }
        for image in images ?? [] { try image.validate(image: true) }
        var records: [String: Int] = [:]
        for book in books {
            guard book.title.count <= 2000, book.author.count <= 2000, book.sha256.range(of: "^[0-9a-f]{64}\\z", options: .regularExpression) != nil,
                  book.file.range(of: "^books/[0-9a-f]{64}\\.(epub|pdf|txt|fb2|cbz)\\z", options: .regularExpression) != nil,
                  URL(fileURLWithPath: book.file).deletingPathExtension().lastPathComponent == book.sha256, book.bookmarks.count <= 10000 else { throw LibraryFailure.invalidFile }
            if let record = book.records { try record.validate(); if let previous = records[record.file], previous != record.size { throw LibraryFailure.invalidFile }; records[record.file] = record.size }
            try book.position.validate()
            for mark in book.bookmarks { guard mark.title.count <= 2000, mark.id.map(TransferRecords.validID) != false, mark.createdAt.map({ $0.isFinite && (0...4102444800).contains($0) }) != false else { throw LibraryFailure.invalidFile }; try mark.position.validate() }
        }
        guard records.values.reduce(0, +) <= Self.maxRecordBytes else { throw LibraryFailure.tooLarge }
    }
    public static func hash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
