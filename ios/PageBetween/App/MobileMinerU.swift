import Foundation
import PDFKit
import ReadiumZIPFoundation

private final class MinerUTransferPolicy: NSObject, URLSessionDownloadDelegate {
    let limit: Int64
    init(limit: Int) { self.limit = Int64(limit) }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > limit || totalBytesExpectedToWrite > limit { downloadTask.cancel() }
    }
}

private actor MinerULayoutData {
    var data = Data()
    func append(_ part: Data) throws { guard data.count + part.count <= 64 * 1024 * 1024 else { throw MinerUFailure.invalidReply }; data.append(part) }
}

actor MobileMinerU {
    let repository: LibraryRepository
    private let network: URLSession
    init(repository: LibraryRepository, network: URLSession? = nil) {
        self.repository = repository
        if let network { self.network = network; return }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.network = URLSession(configuration: configuration, delegate: MinerUTransferPolicy(limit: MinerUProtocol.maximumResultBytes), delegateQueue: nil)
    }
    func run(_ book: MobileBook, pages: [Int], profile: MinerUProfile, key: String, fresh: Bool, publish: @escaping @Sendable (PDFPreparationTask) async -> Void) async throws {
        _ = try MinerUProtocol.request(profile: profile, key: key)
        var state = MinerUCheckpoint(book: book, pages: pages, profile: profile)
        if !fresh, let previous = try await repository.mineruCheckpoint(book.id) {
            if previous.task.pages == pages, previous.profile == profile { state = previous }
            else if previous.task.state != "done" { throw MinerUFailure.unfinishedTask }
        }
        try state.validate()
        let original = try await repository.file(book, name: book.originalName)
        guard let source = CGPDFDocument(original as CFURL), let last = pages.last, last <= source.numberOfPages else { throw LibraryFailure.invalidFile }
        let working = FileManager.default.temporaryDirectory.appendingPathComponent("mineru-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: working, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: working) }
        state.task.state = "running"
        do {
            try await checkpoint(state, publish: publish)
            var offset = 0, batchIndex = 0
            while offset < pages.count {
                try Task.checkCancellation()
                let input = working.appendingPathComponent("input.pdf"), output = working.appendingPathComponent("result.zip")
                var batch: MinerUBatch
                if batchIndex < state.batches.count { batch = state.batches[batchIndex] }
                else {
                    let subset = try writeBatch(source, pages: Array(pages.dropFirst(offset).prefix(MinerUProtocol.maximumPages)), to: input)
                    batch = MinerUBatch(pages: subset); state.batches.append(batch)
                    try await checkpoint(state, publish: publish)
                }
                if batch.published {
                    // Recheck durable pages before treating an interrupted publication as complete.
                    var intact = true
                    for page in batch.pages { if try await repository.pdfPage(book.id, page: page)?.mineruCompleted != true { intact = false } }
                    if intact { offset += batch.pages.count; batchIndex += 1; continue }
                    batch.published = false
                }
                if batch.id == nil {
                    if !FileManager.default.fileExists(atPath: input.path) { _ = try writeBatch(source, pages: batch.pages, to: input, allowSplit: false) }
                    state.task.message = "提交第 \(batch.pages.first!)-\(batch.pages.last!) 页"
                    await publish(state.task)
                    let response = try await api(MinerUProtocol.request(profile: profile, key: key))
                    guard let id = response["batch_id"] as? String, MinerUProtocol.validBatchID(id), let urls = response["file_urls"] as? [String], urls.count == 1 else { throw MinerUFailure.invalidReply }
                    let address = try MinerUProtocol.resource(urls[0], base: profile.baseURL)
                    batch.id = id; state.batches[batchIndex] = batch
                    try await checkpoint(state, publish: publish)
                    var upload = URLRequest(url: address); upload.httpMethod = "PUT"; upload.timeoutInterval = 300
                    upload.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
                    // Signed resource URLs must never receive the service Bearer token.
                    let (_, reply) = try await network.upload(for: upload, fromFile: input)
                    guard let http = reply as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw MinerUFailure.uploadUnconfirmed }
                    batch.uploaded = true; state.batches[batchIndex] = batch
                    try await checkpoint(state, publish: publish)
                }
                try? FileManager.default.removeItem(at: input)
                let started = Date()
                var resource: URL?
                while resource == nil {
                    try Task.checkCancellation()
                    let response = try await api(MinerUProtocol.request(profile: profile, key: key, batch: batch.id))
                    guard let results = response["extract_result"] as? [[String: Any]], results.count == 1, let result = results.first, let status = result["state"] as? String else { throw MinerUFailure.invalidReply }
                    if status == "failed" { throw MinerUFailure.remoteFailed }
                    if status == "done" {
                        guard let value = result["full_zip_url"] as? String else { throw MinerUFailure.invalidReply }
                        resource = try MinerUProtocol.resource(value, base: profile.baseURL); break
                    }
                    guard ["waiting-file", "pending", "running", "converting"].contains(status) else { throw MinerUFailure.invalidReply }
                    if status != "waiting-file", !batch.uploaded { batch.uploaded = true; state.batches[batchIndex] = batch; try await checkpoint(state, publish: publish) }
                    if status == "waiting-file", !batch.uploaded, Date().timeIntervalSince(started) > 60 { throw MinerUFailure.uploadUnconfirmed }
                    if Date().timeIntervalSince(started) > 1800 { throw MinerUFailure.stillRunning }
                    state.task.message = status == "waiting-file" ? "等待云端确认上传" : "云端解析第 \(batch.pages.first!)-\(batch.pages.last!) 页"
                    await publish(state.task)
                    try await Task.sleep(for: .seconds(3))
                }
                state.task.message = "下载并校验解析结果"; await publish(state.task)
                var download = URLRequest(url: resource!); download.timeoutInterval = 180
                let temporary = try await transfer(download, limit: MinerUProtocol.maximumResultBytes)
                try FileManager.default.moveItem(at: temporary, to: output)
                let pages = try await decode(output, pages: batch.pages, hash: book.sourceHash)
                // Validate the entire batch before publishing any page from it.
                for page in pages { try Task.checkCancellation(); try await repository.savePDFPage(book.id, page: page) }
                batch.published = true; state.batches[batchIndex] = batch
                state.task.completed = Array(Set(state.task.completed).union(batch.pages)).sorted()
                try await checkpoint(state, publish: publish)
                try? FileManager.default.removeItem(at: output)
                offset += batch.pages.count; batchIndex += 1
            }
            state.task.state = "done"; state.task.message = ""
            try await checkpoint(state, publish: publish)
        } catch {
            let underlying = error
            state.task.state = Task.isCancelled || error is CancellationError ? "paused" : "failed"
            state.task.message = state.task.state == "paused" ? "" : Self.safeMessage(error)
            try await checkpoint(state, publish: publish)
            throw underlying
        }
    }
    private func checkpoint(_ value: MinerUCheckpoint, publish: @escaping @Sendable (PDFPreparationTask) async -> Void) async throws {
        var state = value; state.task.updatedAt = Date()
        try await repository.saveMinerUCheckpoint(state)
        await publish(state.task)
    }
    private static func safeMessage(_ error: Error) -> String {
        if let error = error as? MinerUFailure { return error.localizedDescription }
        if let error = error as? LibraryFailure { return error.localizedDescription }
        return "解析未完成，请检查网络或服务配置后继续。"
    }
    private func api(_ request: URLRequest) async throws -> [String: Any] {
        let file = try await transfer(request, limit: 4 * 1024 * 1024)
        defer { try? FileManager.default.removeItem(at: file) }
        return try MinerUProtocol.reply(Data(contentsOf: file))
    }
    private func transfer(_ request: URLRequest, limit: Int) async throws -> URL {
        let (file, response) = try await network.download(for: request, delegate: MinerUTransferPolicy(limit: limit))
        do {
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode), (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= limit else { throw MinerUFailure.invalidReply }
            return file
        } catch { try? FileManager.default.removeItem(at: file); throw error }
    }
    private func writeBatch(_ source: CGPDFDocument, pages: [Int], to file: URL, allowSplit: Bool = true) throws -> [Int] {
        var subset = pages
        while true {
            try Task.checkCancellation()
            try? FileManager.default.removeItem(at: file)
            guard let consumer = CGDataConsumer(url: file as CFURL), let context = CGContext(consumer: consumer, mediaBox: nil, nil) else { throw LibraryFailure.invalidFile }
            do {
                for number in subset {
                    try Task.checkCancellation()
                    guard let page = source.page(at: number) else { throw LibraryFailure.invalidFile }
                    let crop = page.getBoxRect(.cropBox), rotated = page.rotationAngle % 180 != 0
                    var media = CGRect(x: 0, y: 0, width: rotated ? crop.height : crop.width, height: rotated ? crop.width : crop.height)
                    guard media.width.isFinite, media.height.isFinite, media.width > 0, media.height > 0 else { throw LibraryFailure.invalidFile }
                    let box = Data(bytes: &media, count: MemoryLayout<CGRect>.size)
                    context.beginPDFPage([kCGPDFContextMediaBox as String: box] as CFDictionary)
                    context.concatenate(page.getDrawingTransform(.cropBox, rect: media, rotate: 0, preserveAspectRatio: true)); context.drawPDFPage(page); context.endPDFPage()
                }
            } catch { context.closePDF(); throw error }
            context.closePDF()
            if (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= MinerUProtocol.maximumUploadBytes { return subset }
            guard allowSplit, subset.count > 1 else { throw MinerUFailure.tooLarge }
            subset = Array(subset.prefix(max(1, subset.count / 2)))
        }
    }
    private func decode(_ file: URL, pages: [Int], hash: String) async throws -> [PDFPreparedPage] {
        let archive = try await Archive(url: file, accessMode: .read)
        let entries = try await archive.entries()
        guard entries.count <= 15000, entries.allSatisfy({ !$0.path.hasPrefix("/") && !$0.path.contains("\\") && !$0.path.split(separator: "/").contains("..") && $0.type != .symlink }) else { throw MinerUFailure.invalidReply }
        let candidates = entries.filter { $0.type == .file && (URL(fileURLWithPath: $0.path).lastPathComponent == "layout.json" || $0.path.hasSuffix("_middle.json")) }
        let layouts = candidates.filter { URL(fileURLWithPath: $0.path).lastPathComponent == "layout.json" }
        guard let entry = (layouts.isEmpty ? candidates : layouts).only, entry.uncompressedSize <= 64 * 1024 * 1024 else { throw MinerUFailure.invalidReply }
        let buffer = MinerULayoutData()
        let checksum = try await archive.extract(entry) { part in try Task.checkCancellation(); try await buffer.append(part) }
        let data = await buffer.data
        guard checksum == entry.checksum, data.count == entry.uncompressedSize else { throw MinerUFailure.invalidReply }
        return try MinerUProtocol.normalize(data, pages: pages, sourceHash: hash)
    }
}

private extension Array { var only: Element? { count == 1 ? first : nil } }
