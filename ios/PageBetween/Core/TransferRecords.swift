import Foundation

public struct TransferFile: Codable, Equatable, Sendable {
    public var file: String
    public var sha256: String
    public var size: Int
    public init(file: String, sha256: String, size: Int) { self.file = file; self.sha256 = sha256; self.size = size }
    public func validate(image: Bool = false) throws {
        let pattern = image ? "^images/[0-9a-f]{64}\\.(png|jpg)\\z" : "^records/[0-9a-f]{64}\\.json\\z"
        guard file.range(of: pattern, options: .regularExpression) != nil,
              sha256 == URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent,
              size > 0, size <= (image ? 4 : 50) * 1024 * 1024 else { throw LibraryFailure.invalidFile }
    }
}
public struct TransferImage: Codable, Equatable, Sendable {
    public var file: String
    public var raw: String
    public init(file: String, raw: String = "") { self.file = file; self.raw = raw }
}
public struct TransferSource: Codable, Equatable, Sendable {
    public var quote: String
    public var markdown: String?
    public var context: String?
    public var contextBefore: String?
    public var position: TransferPosition
    public var kind: String
    public var chapter: String
    public var images: [TransferImage]
    public var objects: [PDFSourceObject]
    public var rects: [PDFSelectionRect]
    public init(quote: String, markdown: String? = nil, position: TransferPosition, kind: String = "text", chapter: String = "", images: [TransferImage] = [], objects: [PDFSourceObject] = [], rects: [PDFSelectionRect] = []) {
        self.quote = quote; self.markdown = markdown; self.position = position; self.kind = kind; self.chapter = chapter; self.images = images; self.objects = objects; self.rects = rects
    }
    public func validate() throws {
        try position.validate()
        guard (context?.count ?? 0) <= 18000, (contextBefore?.count ?? 0) <= 18000 else { throw LibraryFailure.invalidFile }
        guard quote.count <= 12000, (markdown?.count ?? 0) <= 24000, ["text", "equation", "table", "image"].contains(kind), chapter.count <= 2000,
              images.count <= 100, objects.count <= 100, objects.allSatisfy(\.isValid), rects.count <= 1000, rects.allSatisfy(\.isValid),
              images.allSatisfy({ $0.file.range(of: "^images/[0-9a-f]{64}\\.(png|jpg)\\z", options: .regularExpression) != nil && $0.raw.count <= 12000 }) else { throw LibraryFailure.invalidFile }
    }
}
public struct TransferExcerpt: Codable, Sendable {
    public var id: String
    public var source: TransferSource
    public var note: String
    public var answer: String?
    public var translation: String?
    public var createdAt: Double
    public var deletedAt: Double?
    public init(id: String, source: TransferSource, note: String = "", answer: String? = nil, translation: String? = nil, createdAt: Double, deletedAt: Double? = nil) {
        self.id = id; self.source = source; self.note = note; self.answer = answer; self.translation = translation; self.createdAt = createdAt; self.deletedAt = deletedAt
    }
}
public struct TranslationDetails: Codable, Equatable, Sendable {
    public var provider = "google"
    public var model = ""
    public var sourceLanguage = "auto"
    public var targetLanguage = "auto"
    public var detectedLanguage = ""
    public var explanation = ""
    public var originalText: String?
    public init() {}
    public var isValid: Bool { ["google", "ai"].contains(provider) && model.count <= 200 && [sourceLanguage, targetLanguage, detectedLanguage].allSatisfy { $0.count <= 40 } && explanation.count <= 3000 && (originalText?.count ?? 0) <= 12000 }
}

public struct TransferTranslation: Codable, Sendable {
    public var id: String
    public var source: TransferSource
    public var text: String
    public var translation: String
    public var explanation: String
    public var provider: String
    public var model: String
    public var sourceLanguage: String
    public var targetLanguage: String
    public var detectedLanguage: String
    public var createdAt: Double
}
public struct TransferReference: Codable, Equatable, Sendable {
    public var number: Int
    public var citation: String
    public var text: String
    public var position: TransferPosition
}
public struct TransferTurn: Codable, Sendable {
    public var id: String
    public var role: String
    public var content: String
    public var status: String?
    public var imageAttached: Bool?
    public var error: String?
    public var nearbyText: String?
    public var citationWarning: String?
    public var references: [TransferReference]?
}
public struct TransferConversation: Codable, Sendable {
    public var id: String
    public var source: TransferSource
    public var messages: [TransferTurn]
    public var createdAt: Double
    public var updatedAt: Double
}
public struct TransferAppearance: Codable, Equatable, Sendable {
    public var fontScale: Double
    public var lineHeight: Double
    public var pageMargins: Double
    public var fontFamily: String
    public var theme: String
    public var scroll: Bool
    /// Desktop-only choices survive a round trip; supported shared values are applied on both devices.
    public var desktop: String?
    public var isValid: Bool {
        fontScale.isFinite && (50...200).contains(fontScale) && lineHeight.isFinite && (1.4...2.4).contains(lineHeight) && pageMargins.isFinite && (0.5...2).contains(pageMargins) && fontFamily.count <= 200 && ["paper", "sage", "blue", "sepia", "night"].contains(theme) && (desktop?.utf8.count ?? 0) <= 4000
    }
}
public struct TransferRecords: Codable, Sendable {
    public var schema = 1
    public var excerpts: [TransferExcerpt]
    public var translations: [TransferTranslation]
    public var conversations: [TransferConversation]
    public var appearance: TransferAppearance?
    public init(excerpts: [TransferExcerpt] = [], translations: [TransferTranslation] = [], conversations: [TransferConversation] = [], appearance: TransferAppearance? = nil) {
        self.excerpts = excerpts; self.translations = translations; self.conversations = conversations; self.appearance = appearance
    }
    public var images: [TransferImage] { excerpts.flatMap(\.source.images) + translations.flatMap(\.source.images) + conversations.flatMap(\.source.images) }
    public static func validID(_ id: String) -> Bool { id.range(of: "^[0-9a-f]{32}\\z", options: .regularExpression) != nil }
    public static func uuid(_ id: String) throws -> UUID {
        guard validID(id) else { throw LibraryFailure.invalidFile }
        let chars = Array(id), groups = [String(chars[0..<8]), String(chars[8..<12]), String(chars[12..<16]), String(chars[16..<20]), String(chars[20..<32])]
        guard let value = UUID(uuidString: groups.joined(separator: "-")) else { throw LibraryFailure.invalidFile }
        return value
    }
    public static func id(_ id: UUID) -> String { id.uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
    public func validate() throws {
        func date(_ value: Double) -> Bool { value.isFinite && (0...4102444800).contains(value) }
        guard schema == 1, excerpts.count <= 10000, translations.count <= 100, conversations.count <= 10000, appearance?.isValid != false,
              Set(excerpts.map(\.id)).count == excerpts.count, Set(translations.map(\.id)).count == translations.count, Set(conversations.map(\.id)).count == conversations.count else { throw LibraryFailure.invalidFile }
        for item in excerpts {
            try item.source.validate()
            guard Self.validID(item.id), date(item.createdAt), item.deletedAt.map(date) != false, item.note.count <= 2000,
                  (item.answer?.count ?? 0) <= 100000, (item.translation?.count ?? 0) <= 100000 else { throw LibraryFailure.invalidFile }
        }
        for item in translations {
            try item.source.validate()
            guard Self.validID(item.id), date(item.createdAt), item.text.count <= 12000, item.translation.count <= 20000, item.explanation.count <= 3000,
                  ["ai", "google"].contains(item.provider), item.model.count <= 200, [item.sourceLanguage, item.targetLanguage, item.detectedLanguage].allSatisfy({ $0.count <= 40 }) else { throw LibraryFailure.invalidFile }
        }
        for item in conversations {
            try item.source.validate()
            guard Self.validID(item.id), date(item.createdAt), date(item.updatedAt), (1...1000).contains(item.messages.count), Set(item.messages.map(\.id)).count == item.messages.count else { throw LibraryFailure.invalidFile }
            for turn in item.messages {
                guard Self.validID(turn.id), ["user", "assistant"].contains(turn.role), turn.content.count <= 50000,
                      (turn.error?.count ?? 0) <= 2000, (turn.nearbyText?.count ?? 0) <= 18000,
                      (turn.citationWarning?.count ?? 0) <= 1000, (turn.references?.count ?? 0) <= 30,
                      turn.status.map({ ["generating", "complete", "stopped", "error"].contains($0) }) != false else { throw LibraryFailure.invalidFile }
                for reference in turn.references ?? [] {
                    guard (3...32).contains(reference.number), reference.citation.count <= 2000, reference.text.count <= 6000 else { throw LibraryFailure.invalidFile }
                    try reference.position.validate()
                }
            }
        }
    }
}
