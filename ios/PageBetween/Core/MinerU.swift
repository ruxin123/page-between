import Foundation
import CoreFoundation

public enum MinerUFailure: LocalizedError, Equatable {
    case configuration, invalidReply, invalidPages, invalidGeometry, tooLarge, uploadUnconfirmed, remoteFailed, stillRunning, resource, unfinishedTask
    public var errorDescription: String? {
        switch self {
        case .configuration: return "请先配置 MinerU 服务和 Token。"
        case .invalidReply: return "MinerU 返回的解析结果无效，已保留完成页。"
        case .invalidPages: return "解析结果缺页或页序重复，未替换已有内容。"
        case .invalidGeometry: return "解析区块坐标与页面不匹配，未替换已有内容。"
        case .tooLarge: return "单页超过 MinerU 文件大小限制，请先压缩原 PDF。"
        case .uploadUnconfirmed: return "云端尚未确认上传，可稍后继续查询；上传中断时可重新提交所选页。"
        case .remoteFailed: return "云端未能解析此批次，可重新提交所选页。"
        case .stillRunning: return "云端仍在处理，已保存任务，可稍后继续。"
        case .resource: return "解析服务返回了不支持的资源地址。"
        case .unfinishedTask: return "之前的解析任务尚未完成，请继续原任务，或重新提交所选页。"
        }
    }
}

public struct MinerUProfile: Codable, Equatable, Sendable {
    public var baseURL = "https://mineru.net/api/v4"
    public var model = "vlm"
    public var language = "ch"
    public init() {}
    public func validate() throws {
        _ = try ServiceRequests.endpoint(baseURL)
        guard ["vlm", "pipeline"].contains(model), ["ch", "en", "auto"].contains(language) else { throw MinerUFailure.configuration }
    }
}

public struct MinerUBatch: Codable, Equatable, Sendable {
    public var pages: [Int]
    public var id: String?
    public var uploaded = false
    public var published = false
    public init(pages: [Int]) { self.pages = pages }
}

public struct MinerUCheckpoint: Codable, Sendable {
    public var task: PDFPreparationTask
    public var profile: MinerUProfile
    public var batches: [MinerUBatch] = []
    public init(book: MobileBook, pages: [Int], profile: MinerUProfile) {
        task = PDFPreparationTask(book: book.id, sourceHash: book.sourceHash, engine: "mineru", pages: pages); self.profile = profile
    }
    public func validate() throws {
        try profile.validate()
        guard task.engine == "mineru", !task.pages.isEmpty, task.pages.count <= 100000,
              task.pages == Array(Set(task.pages)).sorted(), task.pages.allSatisfy({ (1...100000).contains($0) }),
              Set(task.completed).count == task.completed.count, Set(task.completed).isSubset(of: Set(task.pages)),
              ["running", "paused", "failed", "done", "queued"].contains(task.state) else { throw MinerUFailure.invalidPages }
        let assigned = batches.flatMap(\.pages)
        guard assigned == Array(task.pages.prefix(assigned.count)), batches.allSatisfy({ !$0.pages.isEmpty && $0.pages.count <= MinerUProtocol.maximumPages && ($0.id == nil || MinerUProtocol.validBatchID($0.id!)) }),
              batches.filter(\.published).allSatisfy({ Set($0.pages).isSubset(of: Set(task.completed)) }) else { throw MinerUFailure.invalidPages }
    }
}

public enum MinerUProtocol {
    public static let maximumPages = 150
    public static let maximumUploadBytes = 200_000_000
    public static let maximumResultBytes = 300_000_000
    public static func validBatchID(_ value: String) -> Bool { value.count <= 200 && value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil }
    public static func request(profile: MinerUProfile, key: String, batch: String? = nil) throws -> URLRequest {
        try profile.validate()
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, key.count <= 16000 else { throw MinerUFailure.configuration }
        if let batch, !validBatchID(batch) { throw MinerUFailure.invalidReply }
        let base = try ServiceRequests.endpoint(profile.baseURL)
        var request = URLRequest(url: base.appendingPathComponent(batch.map { "extract-results/batch/" + $0 } ?? "file-urls/batch"))
        request.timeoutInterval = 45; request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        if batch == nil {
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["files": [["name": "page-between-pages.pdf", "is_ocr": true]], "model_version": profile.model, "language": profile.language, "enable_formula": true, "enable_table": true])
        }
        return request
    }
    public static func resource(_ value: String, base: String) throws -> URL {
        guard value.count <= 16000, let url = URL(string: value), url.scheme == "https", let host = url.host?.lowercased(), url.user == nil, url.password == nil, url.fragment == nil, let origin = URL(string: base) else { throw MinerUFailure.resource }
        let trusted = ["mineru.net", "aliyuncs.com", "openxlab.org.cn"].contains { host == $0 || host.hasSuffix("." + $0) }
        let same = url.scheme == origin.scheme && host == origin.host?.lowercased() && (url.port ?? 443) == (origin.port ?? 443)
        guard trusted || same else { throw MinerUFailure.resource }
        return url
    }
    public static func reply(_ data: Data) throws -> [String: Any] {
        guard data.count <= 4 * 1024 * 1024, let body = try JSONSerialization.jsonObject(with: data) as? [String: Any], number(body["code"]) == 0, let payload = body["data"] as? [String: Any] else { throw MinerUFailure.invalidReply }
        return payload
    }
    public static func normalize(_ data: Data, pages originals: [Int], sourceHash: String) throws -> [PDFPreparedPage] {
        guard data.count <= 64 * 1024 * 1024, !originals.isEmpty, originals.count <= maximumPages, Set(originals).count == originals.count,
              let body = try JSONSerialization.jsonObject(with: data) as? [String: Any], let pages = body["pdf_info"] as? [[String: Any]], pages.count == originals.count else { throw MinerUFailure.invalidPages }
        var results: [PDFPreparedPage] = [], seen = Set<Int>()
        for (index, page) in pages.enumerated() {
            guard let sourceIndex = page["page_idx"].map({ number($0) }).flatMap({ $0 }) ?? (page["page_idx"] == nil ? Double(index) : nil), sourceIndex.rounded() == sourceIndex, sourceIndex >= 0, sourceIndex < Double(originals.count), seen.insert(Int(sourceIndex)).inserted,
                  let dimensions = page["page_size"] as? [Any], dimensions.count == 2, let width = number(dimensions[0]), let height = number(dimensions[1]), width > 0, height > 0,
                  let rawBlocks = page["para_blocks"] as? [[String: Any]], rawBlocks.count <= 10000 else { throw MinerUFailure.invalidPages }
            let original = originals[Int(sourceIndex)]
            var result = PDFPreparedPage(page: original, sourceHash: sourceHash, width: width, height: height)
            for (order, raw) in rawBlocks.enumerated() {
                guard let type = raw["type"] as? String else { throw MinerUFailure.invalidReply }
                let kind = ["interline_equation": "equation", "title": "text", "list": "text"][type] ?? type
                guard ["text", "equation", "image", "table"].contains(kind) else { continue }
                guard let rectangle = raw["bbox"] as? [Any], rectangle.count == 4 else { throw MinerUFailure.invalidGeometry }
                let coordinates = rectangle.compactMap(number)
                guard coordinates.count == 4 else { throw MinerUFailure.invalidGeometry }
                let box = PDFBox(coordinates[0] / width, coordinates[1] / height, min(1, coordinates[2] / width), min(1, coordinates[3] / height))
                guard box.isValid, coordinates[2] <= width * 1.01, coordinates[3] <= height * 1.01 else { throw MinerUFailure.invalidGeometry }
                let content = try text(raw, depth: 0)
                let level = number(raw["level"]).flatMap { (1...6).contains($0) && $0.rounded() == $0 ? Int($0) : nil }
                result.blocks.append(PDFContentBlock(id: "p\(original)-b\(order)", type: kind, text: content.0, box: box, order: order, tableHTML: kind == "table" ? content.1 : nil, headingLevel: type == "title" ? level ?? 1 : nil))
            }
            result.mineruCompleted = true; try result.validate(); results.append(result)
        }
        return results.sorted { $0.page < $1.page }
    }
    private static func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
        return value.doubleValue
    }
    private static func text(_ block: [String: Any], depth: Int) throws -> (String, String?) {
        guard depth < 24 else { throw MinerUFailure.invalidReply }
        var parts: [String] = [], html: String?
        for line in block["lines"] as? [[String: Any]] ?? [] {
            var text = ""
            for span in line["spans"] as? [[String: Any]] ?? [] {
                if let content = span["content"] as? String { text += span["type"] as? String == "inline_equation" ? "$" + content + "$" : content }
                if let table = span["html"] as? String { html = html ?? table; text += table }
                guard text.utf8.count <= 2_000_000 else { throw MinerUFailure.invalidReply }
            }
            parts.append(text)
        }
        for child in block["blocks"] as? [[String: Any]] ?? [] { let nested = try text(child, depth: depth + 1); parts.append(nested.0); html = html ?? nested.1 }
        let result = parts.filter { !$0.isEmpty }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.utf8.count <= 2_000_000 else { throw MinerUFailure.invalidReply }
        return (result, html)
    }
}

extension LibraryRepository {
    public func mineruCheckpoint(_ id: UUID) throws -> MinerUCheckpoint? {
        guard let book = books(includingDeleted: true).first(where: { $0.id == id }) else { throw LibraryFailure.missingBook }
        let file = try file(book, name: "preparation/mineru-task.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        var state = try JSONDecoder().decode(MinerUCheckpoint.self, from: Data(contentsOf: file)); try state.validate()
        guard state.task.book == id, state.task.sourceHash == book.sourceHash else { throw LibraryFailure.invalidFile }
        if ["running", "queued"].contains(state.task.state) { state.task.state = "paused" }
        return state
    }
    public func saveMinerUCheckpoint(_ state: MinerUCheckpoint) throws {
        try state.validate()
        guard let book = books().first(where: { $0.id == state.task.book }), book.format == "pdf", state.task.sourceHash == book.sourceHash else { throw LibraryFailure.invalidFile }
        let file = try file(book, name: "preparation/mineru-task.json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: file, options: .atomic)
    }
}
