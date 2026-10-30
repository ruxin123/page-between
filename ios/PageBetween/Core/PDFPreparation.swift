import Foundation

public struct PDFBox: Codable, Equatable, Sendable {
    public var left: Double
    public var top: Double
    public var right: Double
    public var bottom: Double
    public init(_ left: Double, _ top: Double, _ right: Double, _ bottom: Double) { self.left = left; self.top = top; self.right = right; self.bottom = bottom }
    public var isValid: Bool { [left, top, right, bottom].allSatisfy(\.isFinite) && 0 <= left && left < right && right <= 1 && 0 <= top && top < bottom && bottom <= 1 }
    public func overlaps(_ other: PDFBox) -> Bool { max(left, other.left) < min(right, other.right) && max(top, other.top) < min(bottom, other.bottom) }
}

public struct PDFWord: Codable, Equatable, Sendable {
    public var text: String
    public var box: PDFBox
    public var confidence: Double
    public var line: Int
    public init(text: String, box: PDFBox, confidence: Double, line: Int) { self.text = text; self.box = box; self.confidence = confidence; self.line = line }
}

public struct PDFContentBlock: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var type: String
    public var text: String
    public var box: PDFBox
    public var order: Int
    public var tableHTML: String?
    public var headingLevel: Int?
    public init(id: String, type: String, text: String, box: PDFBox, order: Int, tableHTML: String? = nil, headingLevel: Int? = nil) { self.id = id; self.type = type; self.text = text; self.box = box; self.order = order; self.tableHTML = tableHTML; self.headingLevel = headingLevel }
}

public struct PDFPreparedPage: Codable, Equatable, Sendable {
    public var page: Int
    public var sourceHash: String
    public var width: Double
    public var height: Double
    public var words: [PDFWord] = []
    public var blocks: [PDFContentBlock] = []
    public var ocrCompleted = false
    public var hasNativeText = false
    public var ocrRevision: UUID?
    public var mineruCompleted = false
    public init(page: Int, sourceHash: String, width: Double, height: Double) { self.page = page; self.sourceHash = sourceHash; self.width = width; self.height = height }
    public var text: String {
        if mineruCompleted { return blocks.sorted { $0.order < $1.order }.map(\.text).joined(separator: "\n\n") }
        return Dictionary(grouping: words, by: \.line).sorted { $0.key < $1.key }.map { $0.value.map(\.text).joined(separator: " ") }.joined(separator: "\n")
    }
    public func validate() throws {
        guard page > 0, sourceHash.count == 64, width.isFinite, height.isFinite, width > 0, height > 0,
              words.count <= 30000, blocks.count <= 10000,
              words.allSatisfy({ $0.box.isValid && $0.text.utf8.count <= 10000 && $0.confidence.isFinite && (0...1).contains($0.confidence) }),
              blocks.allSatisfy({ $0.box.isValid && ["text", "equation", "image", "table"].contains($0.type) && $0.text.utf8.count <= 2_000_000 }),
              Set(blocks.map(\.id)).count == blocks.count else { throw LibraryFailure.invalidFile }
    }
}

public struct PDFPreparationTask: Codable, Identifiable, Sendable {
    public var id = UUID()
    public var book: UUID
    public var sourceHash: String
    public var engine: String
    public var pages: [Int]
    public var completed: [Int] = []
    public var state = "paused"
    public var message = ""
    public var updatedAt = Date()
    public var remoteBatches: [String: [Int]] = [:]
    public init(book: UUID, sourceHash: String, engine: String, pages: [Int]) { self.book = book; self.sourceHash = sourceHash; self.engine = engine; self.pages = pages }
}

public enum PDFPageRange {
    public static func parse(_ input: String, total: Int) throws -> [Int] {
        guard total > 0, total <= 100000, input.count <= 2000 else { throw LibraryFailure.invalidFile }
        var pages = Set<Int>()
        for item in input.replacingOccurrences(of: "，", with: ",").split(separator: ",", omittingEmptySubsequences: false) {
            let limits = item.trimmingCharacters(in: .whitespaces).split(separator: "-", omittingEmptySubsequences: false)
            guard (1...2).contains(limits.count), let first = Int(limits[0].trimmingCharacters(in: .whitespaces)), let last = Int(limits.last!.trimmingCharacters(in: .whitespaces)), first >= 1, last >= first, last <= total else { throw LibraryFailure.invalidFile }
            pages.formUnion(first...last)
        }
        return pages.sorted()
    }
}

extension LibraryRepository {
    public func pdfPage(_ id: UUID, page: Int) throws -> PDFPreparedPage? {
        guard page > 0, let book = books(includingDeleted: true).first(where: { $0.id == id }), book.format == "pdf" else { throw LibraryFailure.invalidFile }
        let url = try file(book, name: "preparation/page-\(page).json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let result = try JSONDecoder().decode(PDFPreparedPage.self, from: Data(contentsOf: url))
        try result.validate()
        guard result.page == page, result.sourceHash == book.sourceHash else { throw LibraryFailure.invalidFile }
        return result
    }
    public func savePDFPage(_ id: UUID, page: PDFPreparedPage) throws {
        try page.validate()
        guard let book = books().first(where: { $0.id == id }), book.format == "pdf", book.sourceHash == page.sourceHash else { throw LibraryFailure.invalidFile }
        var result = page
        if let previous = try pdfPage(id, page: page.page) {
            if !page.ocrCompleted { result.words = previous.words; result.ocrCompleted = previous.ocrCompleted; result.hasNativeText = previous.hasNativeText; result.ocrRevision = previous.ocrRevision }
            if !page.mineruCompleted { result.blocks = previous.blocks; result.mineruCompleted = previous.mineruCompleted }
        }
        let url = try file(book, name: "preparation/page-\(page.page).json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(result).write(to: url, options: .atomic)
    }
    public func savePDFTask(_ task: PDFPreparationTask) throws {
        guard let book = books().first(where: { $0.id == task.book }), book.sourceHash == task.sourceHash, ["ocr", "mineru"].contains(task.engine), task.pages == Array(Set(task.pages)).sorted(), task.pages.allSatisfy({ $0 > 0 && $0 <= 100000 }), Set(task.completed).isSubset(of: Set(task.pages)), ["queued", "running", "paused", "failed", "done"].contains(task.state) else { throw LibraryFailure.invalidFile }
        let url = try file(book, name: "preparation/task-\(task.engine).json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(task).write(to: url, options: .atomic)
    }
    public func pdfTask(_ id: UUID, engine: String) throws -> PDFPreparationTask? {
        guard ["ocr", "mineru"].contains(engine), let book = books(includingDeleted: true).first(where: { $0.id == id }) else { throw LibraryFailure.invalidFile }
        let url = try file(book, name: "preparation/task-\(engine).json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        var result = try JSONDecoder().decode(PDFPreparationTask.self, from: Data(contentsOf: url))
        guard result.book == id, result.sourceHash == book.sourceHash else { throw LibraryFailure.invalidFile }
        if ["queued", "running"].contains(result.state) { result.state = "paused" }
        return result
    }
}
