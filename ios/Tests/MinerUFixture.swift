import Foundation
import PDFKit
import ReadiumZIPFoundation

private final class FixtureServer: @unchecked Sendable {
    static let shared = FixtureServer()
    let lock = NSLock()
    var archives: [String: Data] = [:]
    var posts = 0, puts = 0, resumedSecond = false
    var validatedPDFSizes: [Int] = []
    func respond(_ request: URLRequest) throws -> (Int, Data) {
        lock.lock(); defer { lock.unlock() }
        let path = request.url!.path
        if path == "/api/v4/file-urls/batch" {
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer anonymous-test-token" else { throw MinerUFailure.configuration }
            let payload = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            guard payload["enable_formula"] as? Bool == true, payload["enable_table"] as? Bool == true else { throw MinerUFailure.invalidReply }
            posts += 1
            return try json(["code": 0, "data": ["batch_id": "batch-\(posts)", "file_urls": ["https://fixture.invalid/upload/\(posts)"]]])
        }
        if path.hasPrefix("/upload/") {
            guard request.value(forHTTPHeaderField: "Authorization") == nil, request.httpMethod == "PUT" else { throw MinerUFailure.resource }
            puts += 1
            var body = request.httpBody ?? Data()
            if body.isEmpty, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 32768)
                while true { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; body.append(buffer, count: count) }
            }
            if !body.isEmpty {
                guard let document = PDFDocument(data: body) else { throw LibraryFailure.invalidFile }
                validatedPDFSizes.append(document.pageCount)
            }
            // A failed acknowledgement is ambiguous: the server may already have received the file.
            if path == "/upload/2" { return (503, Data()) }
            return (200, Data())
        }
        if path.hasPrefix("/api/v4/extract-results/batch/") {
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer anonymous-test-token" else { throw MinerUFailure.configuration }
            let id = request.url!.lastPathComponent
            if id == "batch-2" { resumedSecond = true }
            return try json(["code": 0, "data": ["extract_result": [["state": "done", "full_zip_url": "https://fixture.invalid/result/\(id).zip"]]]])
        }
        guard request.value(forHTTPHeaderField: "Authorization") == nil, let archive = archives[path] else { throw MinerUFailure.resource }
        return (200, archive)
    }
    private func json(_ value: [String: Any]) throws -> (Int, Data) { (200, try JSONSerialization.data(withJSONObject: value)) }
}

private final class FixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (code, data) = try FixtureServer.shared.respond(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "\(data.count)"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@main struct MinerUFixture {
    static func verify(_ condition: Bool, _ message: String) { if !condition { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) } }
    static func main() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mineru-fixture-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        for (offset, range) in [1...150, 151...300, 301...301].enumerated() {
            let source = folder.appendingPathComponent("source-\(offset)"), archiveURL = folder.appendingPathComponent("batch-\(offset + 1).zip")
            try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
            let pages = range.enumerated().map { index, original in ["page_idx": index, "page_size": [600,800], "para_blocks": [["type": "interline_equation", "bbox": [40,50,400,100], "lines": [["spans": [["type": "interline_equation", "content": "x_{\(original)}=\\emptyset"]]]]]]] as [String: Any] }
            try JSONSerialization.data(withJSONObject: ["pdf_info": pages]).write(to: source.appendingPathComponent("layout.json"))
            let archive = try await Archive(url: archiveURL, accessMode: .create)
            try await archive.addEntry(with: "layout.json", relativeTo: source, compressionMethod: .deflate)
            FixtureServer.shared.archives["/result/batch-\(offset + 1).zip"] = try Data(contentsOf: archiveURL)
        }
        let input = folder.appendingPathComponent("original.pdf")
        var media = CGRect(x: 0, y: 0, width: 600, height: 800)
        let context = CGContext(consumer: CGDataConsumer(url: input as CFURL)!, mediaBox: &media, nil)!
        for _ in 1...301 { context.beginPDFPage(nil); context.endPDFPage() }; context.closePDF()
        let root = folder.appendingPathComponent("Library"), repo = try LibraryRepository(root: root)
        let book = try await repo.importFile(input)
        var profile = MinerUProfile(); profile.baseURL = "https://fixture.invalid/api/v4"
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [FixtureProtocol.self]
        let network = URLSession(configuration: configuration)
        let worker = MobileMinerU(repository: repo, network: network)
        do { try await worker.run(book, pages: Array(1...301), profile: profile, key: "anonymous-test-token", fresh: false) { _ in }; verify(false, "Expected interrupted upload acknowledgement") } catch {}
        let interrupted = try await repo.mineruCheckpoint(book.id)
        verify(interrupted?.task.completed.count == 150 && interrupted?.task.state == "failed", "Completed batch was lost on interruption")
        verify(interrupted?.batches.last?.id == "batch-2", "Ambiguous upload lost its batch ID")
        let restarted = try LibraryRepository(root: root), resumed = MobileMinerU(repository: restarted, network: network)
        try await resumed.run(book, pages: Array(1...301), profile: profile, key: "anonymous-test-token", fresh: false) { _ in }
        let final = try await restarted.mineruCheckpoint(book.id)
        verify(final?.task.state == "done" && final?.task.completed.count == 301, "Resume did not complete all original pages")
        verify(FixtureServer.shared.posts == 3 && FixtureServer.shared.puts == 3 && FixtureServer.shared.resumedSecond, "Resume resubmitted an existing cloud task")
        for number in [1,150,151,300,301] {
            let page = try await restarted.pdfPage(book.id, page: number)
            verify(page?.blocks.first?.text == "x_{\(number)}=\\emptyset", "Chunk indexes were not mapped to original PDF pages")
        }
        if !FixtureServer.shared.validatedPDFSizes.isEmpty { verify(FixtureServer.shared.validatedPDFSizes == [150,150,1], "Uploaded PDF batches have incorrect page counts") }
        let checkpoint = try String(contentsOf: await restarted.file(book, name: "preparation/mineru-task.json"), encoding: .utf8)
        verify(!checkpoint.contains("anonymous-test-token"), "Checkpoint stored a credential")
        print("Production MinerU passed: 301 pages, 150/150/1 batching, interrupted upload, restart without duplicate submission, original page mapping, exact LaTeX, credential isolation; inspected \(FixtureServer.shared.validatedPDFSizes.count) upload bodies.")
    }
}
