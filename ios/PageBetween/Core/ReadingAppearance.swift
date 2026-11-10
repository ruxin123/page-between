import Foundation

public struct ReadingAppearance: Codable, Equatable, Sendable {
    public var fontScale: Double
    public var lineHeight: Double
    public var pageMargins: Double
    public var fontFamily: String
    public var theme: String
    public var scroll: Bool
    public init(fontScale: Double, lineHeight: Double, pageMargins: Double, fontFamily: String, theme: String, scroll: Bool) {
        self.fontScale = fontScale
        self.lineHeight = lineHeight
        self.pageMargins = pageMargins
        self.fontFamily = fontFamily
        self.theme = theme
        self.scroll = scroll
    }
    public var isValid: Bool {
        fontScale.isFinite && (70...200).contains(fontScale) && lineHeight.isFinite && (1.4...2.2).contains(lineHeight) && pageMargins.isFinite && (0.5...2).contains(pageMargins) && fontFamily.count < 200 && ["paper", "sepia", "night"].contains(theme)
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
        (!quote.isEmpty || !objects.isEmpty) && quote.count <= 12000 && (markdown?.count ?? 0) <= 24000 && locator.utf8.count <= 64000 && (try? JSONSerialization.jsonObject(with: Data(locator.utf8))) is [String: Any] && chapter.count <= 2000 && note.count <= 2000 && objects.count <= 100 && objects.allSatisfy(\.isValid) && (rects?.count ?? 0) <= 1000 && rects?.allSatisfy(\.isValid) != false && (answer?.count ?? 0) <= 100000
    }
}
