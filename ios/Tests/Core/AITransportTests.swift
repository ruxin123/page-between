import XCTest
@testable import PageBetweenCore

private final class OriginalStreamProtocol: URLProtocol {
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "stream.example.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() { lock.withLock { stopped = true } }
    override func startLoading() {
        let json = request.url?.path == "/json"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": json ? "application/json" : "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        let payload = json ? #"{"choices":[{"message":{"content":"Complete original answer"}}]}"# : "data: {\"choices\":[{\"delta\":{\"content\":\"Original 🪶 \"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"$x^2$\"}}]}\n\ndata: [DONE]\n\n"
        let data = Data((request.url?.path == "/truncated" ? payload.replacingOccurrences(of: "data: [DONE]\n\n", with: "") : payload).utf8)
        let split = data.firstIndex(of: 0xf0).map { $0 + 2 } ?? data.count / 2
        let chunks = [Data(data[..<split]), Data(data[split...])]
        for (index, chunk) in chunks.enumerated() {
            DispatchQueue.global().asyncAfter(deadline: .now() + Double(index) * (self.request.url?.path == "/slow" ? 3 : 0.05)) { [self] in
                lock.withLock {
                    guard !stopped else { return }
                    client?.urlProtocol(self, didLoad: chunk)
                    if index == chunks.count - 1 { client?.urlProtocolDidFinishLoading(self) }
                }
            }
        }
    }
}

private actor StreamParts {
    var values: [String] = []
    func add(_ value: String) { values.append(value) }
}

final class AITransportTests: XCTestCase {
    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OriginalStreamProtocol.self]; configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }
    func testProductionTransportDecodesNetworkChunksAndJSONFallback() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let parts = StreamParts()
        let result = try await AITransport.stream(URLRequest(url: URL(string: "https://stream.example.invalid/stream")!), session: session) { await parts.add($0) }
        XCTAssertEqual(result, "Original 🪶 $x^2$")
        let fragments = await parts.values
        XCTAssertEqual(fragments, ["Original 🪶 ", "$x^2$"])
        let json = try await AITransport.stream(URLRequest(url: URL(string: "https://stream.example.invalid/json")!), session: session) { _ in }
        XCTAssertEqual(json, "Complete original answer")
    }
    func testCancellationStopsAnUnfinishedNetworkResponse() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let task = Task { try await AITransport.stream(URLRequest(url: URL(string: "https://stream.example.invalid/slow")!), session: session) { _ in } }
        try await Task.sleep(for: .milliseconds(50)); task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled stream succeeded") }
        catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
    }
    func testNetworkEOFDoesNotMarkPartialContentComplete() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let parts = StreamParts()
        do {
            _ = try await AITransport.stream(URLRequest(url: URL(string: "https://stream.example.invalid/truncated")!), session: session) { await parts.add($0) }
            XCTFail("Truncated answer was marked complete")
        } catch { XCTAssertTrue(error is ServiceRequestFailure) }
        let fragments = await parts.values
        XCTAssertEqual(fragments.joined(), "Original 🪶 $x^2$")
    }
}
