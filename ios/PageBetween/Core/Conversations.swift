import Foundation

public struct MobileTurn: Codable, Identifiable, Equatable, Sendable {
    public var id = UUID()
    public let role: String
    public let content: String
    public init(role: String, content: String) { self.role = role; self.content = content }
}

public struct MobileConversation: Codable, Identifiable, Equatable, Sendable {
    public var id = UUID()
    public let book: UUID
    public let quote: String
    public let locator: String
    public var turns: [MobileTurn] = []
    public var createdAt = Date()
    public var updatedAt = Date()
    public init(book: UUID, quote: String, locator: String) { self.book = book; self.quote = quote; self.locator = locator }
}

extension LibraryRepository {
    public func saveConversation(_ conversation: MobileConversation) throws {
        guard let book = books(includingDeleted: true).first(where: { $0.id == conversation.book }), book.deletedAt == nil else { throw LibraryFailure.missingBook }
        guard conversation.quote.count <= 12000, conversation.locator.utf8.count <= 30000, conversation.turns.count <= 40,
              conversation.turns.allSatisfy({ ["user", "assistant"].contains($0.role) && $0.content.count <= 50000 }) else { throw ServiceRequestFailure.selectionTooLong }
        let directory = try file(book, name: "conversations")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(conversation).write(to: directory.appendingPathComponent(conversation.id.uuidString + ".json"), options: .atomic)
    }
    public func conversations(_ id: UUID, offset: Int = 0) throws -> [MobileConversation] {
        guard let book = books(includingDeleted: true).first(where: { $0.id == id }) else { throw LibraryFailure.missingBook }
        let directory = try file(book, name: "conversations")
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let entries = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey])
        let sorted = entries.filter { $0.pathExtension == "json" && UUID(uuidString: $0.deletingPathExtension().lastPathComponent) != nil }.sorted {
            ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }
        return try sorted.dropFirst(max(0, offset)).prefix(30).map { url in
            let item = try JSONDecoder().decode(MobileConversation.self, from: Data(contentsOf: url))
            guard item.book == id else { throw LibraryFailure.invalidFile }
            return item
        }
    }
}
