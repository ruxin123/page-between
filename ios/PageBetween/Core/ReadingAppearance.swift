import Foundation

public struct ReadingAppearance: Codable, Equatable, Sendable {
    public var fontScale: Double
    public var lineHeight: Double
    public var pageMargins: Double
    public var fontFamily: String
    public var theme: String
    public var scroll: Bool
    public var overrides: [String]?

    public static let fields = ["fontScale", "lineHeight", "pageMargins", "fontFamily", "theme", "scroll"]

    public func inherited(from defaults: Self) -> Self {
        guard let overrides else { return self }
        return Self(fontScale: overrides.contains("fontScale") ? fontScale : defaults.fontScale,
            lineHeight: overrides.contains("lineHeight") ? lineHeight : defaults.lineHeight,
            pageMargins: overrides.contains("pageMargins") ? pageMargins : defaults.pageMargins,
            fontFamily: overrides.contains("fontFamily") ? fontFamily : defaults.fontFamily,
            theme: overrides.contains("theme") ? theme : defaults.theme,
            scroll: overrides.contains("scroll") ? scroll : defaults.scroll)
    }

    public func changedFields(from previous: Self) -> [String] {
        zip(Self.fields, [fontScale != previous.fontScale, lineHeight != previous.lineHeight,
            pageMargins != previous.pageMargins, fontFamily != previous.fontFamily,
            theme != previous.theme, scroll != previous.scroll]).compactMap { $0.1 ? $0.0 : nil }
    }
    public init(fontScale: Double, lineHeight: Double, pageMargins: Double, fontFamily: String, theme: String, scroll: Bool) {
        self.fontScale = fontScale
        self.lineHeight = lineHeight
        self.pageMargins = pageMargins
        self.fontFamily = fontFamily
        self.theme = theme
        self.scroll = scroll
    }
    public var isValid: Bool {
        overrides?.allSatisfy(Self.fields.contains) != false && (overrides?.count ?? 0) <= Self.fields.count && fontScale.isFinite && (70...200).contains(fontScale) && lineHeight.isFinite && (1.4...2.2).contains(lineHeight) && pageMargins.isFinite && (0.5...2).contains(pageMargins) && fontFamily.count < 200 && ["paper", "sepia", "night"].contains(theme)
    }
}

public struct PDFSelectionRect: Codable, Equatable, Sendable {
    public var page: Int
    public var box: PDFBox
    public init(page: Int, box: PDFBox) { self.page = page; self.box = box }
    public var isValid: Bool { (1...100000).contains(page) && box.isValid }
}

public struct SavedExcerpt: Codable, Identifiable, Equatable, Sendable {
    public var id = UUID()
    public var quote: String
    public var markdown: String?
    public var locator: String
    public var chapter: String
    public var objects: [PDFSourceObject]
    public var rects: [PDFSelectionRect]?
    public var note = ""
    public var answer: String?
    public var translation: String?
    public var translationInput: String?
    public var translationDetails: TranslationDetails?
    public var attachments: [SourceAttachment]?
    public var sourceContext: String?
    public var sourceContextBefore: String?
    public var transferredPosition: TransferPosition?
    public var createdAt = Date()
    public var deletedAt: Date?
    public init(quote: String, markdown: String?, locator: String, chapter: String, objects: [PDFSourceObject] = [], rects: [PDFSelectionRect] = []) {
        self.quote = quote
        self.markdown = markdown
        self.locator = locator
        self.chapter = chapter
        self.objects = objects
        self.rects = rects.isEmpty ? nil : rects
    }
    public var isValid: Bool {
        guard !quote.isEmpty || !objects.isEmpty || !(attachments ?? []).isEmpty,
              quote.count <= 12000, (markdown?.count ?? 0) <= 24000, chapter.count <= 2000, note.count <= 2000,
              locator.utf8.count <= 64000, (try? JSONSerialization.jsonObject(with: Data(locator.utf8))) is [String: Any] else { return false }
        guard objects.count <= 100, objects.allSatisfy(\.isValid),
              (rects?.count ?? 0) <= 1000, rects?.allSatisfy(\.isValid) != false,
              (attachments?.count ?? 0) <= 100, attachments?.allSatisfy(\.isValid) != false else { return false }
        guard (sourceContext?.count ?? 0) <= 18000, (sourceContextBefore?.count ?? 0) <= 18000 else { return false }
        return (answer?.count ?? 0) <= 100000 && (translationInput?.count ?? 0) <= 12000 && (translation?.count ?? 0) <= 100000 && translationDetails?.isValid != false
    }
}
