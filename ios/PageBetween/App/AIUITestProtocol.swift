#if DEBUG
import Foundation

final class AIUITestProtocol: URLProtocol {
    static var enabled: Bool { ProcessInfo.processInfo.environment["PAGE_BETWEEN_AI_UI_TEST"] == "1" }
    private static let counterLock = NSLock()
    private static var count = 0
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { enabled && request.url?.host == "stream.example.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() { lock.withLock { stopped = true } }
    override func startLoading() {
        let first = Self.counterLock.withLock { Self.count += 1; return Self.count == 1 }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        let chunks = first ? ["Original streamed "] + Array(repeating: "content ", count: 19) : ["Original completed ", #"answer $x^2$."#]
        for (index, chunk) in chunks.enumerated() {
            DispatchQueue.global().asyncAfter(deadline: .now() + Double(index) * (first ? 1 : 0.1)) { [self] in
                lock.withLock {
                    guard !stopped else { return }
                    let event = try! JSONSerialization.data(withJSONObject: ["choices": [["delta": ["content": chunk]]]])
                    client?.urlProtocol(self, didLoad: Data(("data: " + String(decoding: event, as: UTF8.self) + "\n\n").utf8))
                    if index == chunks.count - 1 { client?.urlProtocol(self, didLoad: Data("data: [DONE]\n\n".utf8)); client?.urlProtocolDidFinishLoading(self) }
                }
            }
        }
    }
}
#endif
