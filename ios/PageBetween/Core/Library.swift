import Foundation
import CryptoKit

public struct ReadingBookmark: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID = UUID()
    public var title: String
    public var locator: String
    public var createdAt: Date = Date()
    public init(title: String, locator: String) { self.title = title; self.locator = locator }
}

public struct MobileBook: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var title: String
    public var author: String
    public var format: String
    public var sourceHash: String
    public var originalName: String
    public var readingFile: String
    public var importedAt: Date
    public var lastOpened: Date?
    public var locator: String?
    public var progress: Double = 0
    public var chapter: String = ""
    public var pinned: Bool = false
    public var deletedAt: Date?
    public var bookmarks: [ReadingBookmark] = []
}

public struct MobileCatalog: Codable, Sendable {
    public var schema = 1
    public var books: [MobileBook] = []
    public init() {}
}

public enum LibraryFailure: LocalizedError {
    case invalidFile, unsupported, tooLarge, missingBook, invalidPath
    public var errorDescription: String? {
        switch self {
        case .invalidFile: return "文件无法读取，请重新选择。"
        case .unsupported: return "请选择 EPUB、PDF、TXT 或 CBZ 文件。"
        case .tooLarge: return "文件超过 300 MB，请先缩小文件。"
        case .missingBook: return "找不到这本书。"
        case .invalidPath: return "书籍资源路径无效。"
        }
    }
}

public actor LibraryRepository {
    public let root: URL
    private var catalog: MobileCatalog
    private let manager = FileManager.default

    public init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent("library.json")
        if FileManager.default.fileExists(atPath: url.path) {
            // A corrupt catalog is reported, never silently replaced with an empty library.
            catalog = try JSONDecoder().decode(MobileCatalog.self, from: Data(contentsOf: url))
        } else { catalog = MobileCatalog() }
    }

    public func books(includingDeleted: Bool = false) -> [MobileBook] {
        catalog.books.filter { includingDeleted || $0.deletedAt == nil }
    }

    public func file(_ book: MobileBook, name: String? = nil) throws -> URL {
        let folder = root.appendingPathComponent("books/" + book.id.uuidString, isDirectory: true)
        let path = folder.appendingPathComponent(name ?? book.readingFile).standardizedFileURL
        guard path.path.hasPrefix(folder.path + "/"), !path.lastPathComponent.isEmpty else { throw LibraryFailure.invalidPath }
        return path
    }

    public func importFile(_ source: URL) throws -> MobileBook {
        let format = source.pathExtension.lowercased()
        guard ["epub", "pdf", "txt", "cbz"].contains(format) else { throw LibraryFailure.unsupported }
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let size = values.fileSize, size > 0 else { throw LibraryFailure.invalidFile }
        guard size <= 300 * 1024 * 1024 else { throw LibraryFailure.tooLarge }
        let stream = try FileHandle(forReadingFrom: source)
        defer { try? stream.close() }
        var hash = SHA256()
        while let part = try stream.read(upToCount: 1024 * 1024), !part.isEmpty { hash.update(data: part) }
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        if var existing = catalog.books.first(where: { $0.sourceHash == digest }) {
            if existing.deletedAt != nil { existing.deletedAt = nil; try update(existing) }
            return existing
        }
        let id = UUID(), folder = root.appendingPathComponent("books/" + id.uuidString, isDirectory: true)
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        do {
            let name = "original." + format
            try manager.copyItem(at: source, to: folder.appendingPathComponent(name))
            let book = MobileBook(id: id, title: source.deletingPathExtension().lastPathComponent, author: "", format: format, sourceHash: digest, originalName: name, readingFile: name, importedAt: Date())
            var next = catalog; next.books.append(book)
            try persist(next)
            return book
        } catch { try? manager.removeItem(at: folder); throw error }
    }

    public func update(_ book: MobileBook) throws {
        guard let index = catalog.books.firstIndex(where: { $0.id == book.id }) else { throw LibraryFailure.missingBook }
        var next = catalog; next.books[index] = book
        try persist(next)
    }

    public func markDeleted(_ id: UUID, deleted: Bool) throws {
        guard var book = catalog.books.first(where: { $0.id == id }) else { throw LibraryFailure.missingBook }
        book.deletedAt = deleted ? Date() : nil
        try update(book)
    }

    public func saveLocation(_ id: UUID, locator: String, progress: Double, chapter: String) throws {
        guard var book = catalog.books.first(where: { $0.id == id }) else { throw LibraryFailure.missingBook }
        book.locator = locator; book.progress = progress.isFinite ? min(1, max(0, progress)) : 0
        book.chapter = chapter; book.lastOpened = Date()
        try update(book)
    }

    public func toggleBookmark(_ id: UUID, title: String, locator: String) throws {
        guard var book = catalog.books.first(where: { $0.id == id }) else { throw LibraryFailure.missingBook }
        if let index = book.bookmarks.firstIndex(where: { $0.locator == locator }) { book.bookmarks.remove(at: index) }
        else { book.bookmarks.append(ReadingBookmark(title: title, locator: locator)) }
        try update(book)
    }

    public func discardFailedImport(_ id: UUID) throws {
        guard let book = catalog.books.first(where: { $0.id == id }), book.lastOpened == nil, book.bookmarks.isEmpty, book.locator == nil else { throw LibraryFailure.invalidFile }
        let folder = root.appendingPathComponent("books/" + id.uuidString, isDirectory: true)
        guard !manager.fileExists(atPath: folder.appendingPathComponent("conversations").path) else { throw LibraryFailure.invalidFile }
        var next = catalog; next.books.removeAll { $0.id == id }
        try persist(next)
        try manager.removeItem(at: folder)
    }

    private func persist(_ next: MobileCatalog) throws {
        let data = try JSONEncoder().encode(next)
        try data.write(to: root.appendingPathComponent("library.json"), options: .atomic)
        catalog = next
    }
}
