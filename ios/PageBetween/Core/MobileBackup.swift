import Foundation

public struct MobileBackupFile: Codable, Sendable {
    public var path: String
    public var size: Int
    public var sha256: String
    public init(path: String, size: Int, sha256: String) { self.path = path; self.size = size; self.sha256 = sha256 }
}

/// Device backup, distinct from portable migration. Credentials are never part of its namespace.
public struct MobileBackupManifest: Codable, Sendable {
    public var schema = 1
    public var kind = "page-between-mobile-backup"
    public var createdAt = Date()
    public var files: [MobileBackupFile]
    public init(files: [MobileBackupFile]) { self.files = files }
    public static let maxTotal = 2 * 1024 * 1024 * 1024
    public static func validPath(_ path: String) -> Bool {
        if path == "library.json" { return true }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return path.utf8.count <= 1000 && parts.count >= 3 && parts[0] == "books" && UUID(uuidString: String(parts[1]))?.uuidString == String(parts[1]) && parts.dropFirst(2).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") && !$0.hasPrefix(".") && $0 != "credentials.json" }
    }
    public func validate() throws {
        guard schema == 1, kind == "page-between-mobile-backup", files.count <= 100000,
              Set(files.map(\.path)).count == files.count, files.contains(where: { $0.path == "library.json" }),
              createdAt.timeIntervalSince1970.isFinite else { throw LibraryFailure.invalidFile }
        var total = 0
        for item in files {
            guard Self.validPath(item.path), item.size >= 0, item.size <= 300 * 1024 * 1024,
                  item.path != "library.json" || item.size <= 32 * 1024 * 1024,
                  item.sha256.range(of: "^[0-9a-f]{64}\\z", options: .regularExpression) != nil else { throw LibraryFailure.invalidFile }
            total += item.size
            guard total <= Self.maxTotal else { throw LibraryFailure.tooLarge }
        }
    }
    public func catalog(at staging: URL) throws -> MobileCatalog {
        try validate()
        for item in files {
            let url = staging.appendingPathComponent(item.path)
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == item.size,
                  try TransferManifest.hash(url) == item.sha256 else { throw LibraryFailure.invalidFile }
        }
        let catalog = try JSONDecoder().decode(MobileCatalog.self, from: Data(contentsOf: staging.appendingPathComponent("library.json")))
        let paths = Set(files.map(\.path)), ids = Set(catalog.books.map(\.id))
        guard catalog.schema == 1, catalog.books.count <= 5000, ids.count == catalog.books.count else { throw LibraryFailure.invalidFile }
        for item in files where item.path != "library.json" {
            guard let id = UUID(uuidString: String(item.path.split(separator: "/")[1])), ids.contains(id) else { throw LibraryFailure.invalidFile }
        }
        for item in files {
            let parts = item.path.split(separator: "/")
            if parts.count == 4, parts[2] == "conversations" {
                let conversation = try JSONDecoder().decode(MobileConversation.self, from: Data(contentsOf: staging.appendingPathComponent(item.path)))
                guard conversation.book.uuidString == String(parts[1]), conversation.id.uuidString + ".json" == String(parts[3]), conversation.isValid else { throw LibraryFailure.invalidFile }
            }
        }
        for book in catalog.books {
            let prefix = "books/" + book.id.uuidString + "/"
            guard ["epub", "pdf", "txt", "fb2", "cbz"].contains(book.format),
                  book.sourceHash.range(of: "^[0-9a-f]{64}\\z", options: .regularExpression) != nil,
                  paths.contains(prefix + book.originalName), paths.contains(prefix + book.readingFile),
                  Self.validPath(prefix + book.originalName), Self.validPath(prefix + book.readingFile),
                  !book.originalName.contains("/"), !book.readingFile.contains("/"),
                  book.progress.isFinite, (0...1).contains(book.progress), book.title.count <= 2000,
                  book.author.count <= 2000, book.appearance?.isValid != false,
                  book.bookmarks.count <= 10000, Set(book.bookmarks.map(\.id)).count == book.bookmarks.count,
                  book.bookmarks.allSatisfy({ $0.title.count <= 2000 && $0.locator.utf8.count <= 64000 && (try? JSONSerialization.jsonObject(with: Data($0.locator.utf8))) is [String: Any] }),
                  (book.excerpts?.count ?? 0) <= 10000, book.excerpts?.allSatisfy(\.isValid) != false,
                  try TransferManifest.hash(staging.appendingPathComponent(prefix + book.originalName)) == book.sourceHash else { throw LibraryFailure.invalidFile }
        }
        return catalog
    }
}
