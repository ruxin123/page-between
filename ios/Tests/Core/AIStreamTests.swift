import XCTest
@testable import PageBetweenCore

final class AIStreamTests: XCTestCase {
    func testEventsKeepUnicodeMarkdownAndRawFormulaAcrossChunks() throws {
        var decoder = AIStreamDecoder()
        XCTAssertEqual(try decoder.consume(": heartbeat"), "")
        XCTAssertEqual(try decoder.consume("event: message"), "")
        XCTAssertEqual(try decoder.consume(#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), "")
        XCTAssertEqual(try decoder.consume(""), "")
        var output = ""
        for chunk in ["原文 🪶 ", #"$\sigma"#, #"\in S_n$"#] {
            let data = try JSONSerialization.data(withJSONObject: ["choices": [["delta": ["content": chunk]]]])
            _ = try decoder.consume("data: " + String(decoding: data, as: UTF8.self))
            output += try decoder.consume("")
        }
        _ = try decoder.consume(#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#)
        output += try decoder.consume("")
        XCTAssertEqual(try decoder.finish(), "")
        XCTAssertTrue(decoder.completed)
        XCTAssertEqual(output, #"原文 🪶 $\sigma\in S_n$"#)
    }
    func testIncompleteErrorAndEmptyStreamsCannotMasqueradeAsSuccess() throws {
        var decoder = AIStreamDecoder()
        _ = try decoder.consume(#"data: {"choices":[{"delta":{"content":"partial"}}]}"#)
        XCTAssertEqual(try decoder.consume(""), "partial")
        XCTAssertThrowsError(try decoder.finish())
        for payload in [#"{"error":{"message":"anonymous error"}}"#, "not json"] {
            var invalid = AIStreamDecoder(); _ = try invalid.consume("data: " + payload)
            XCTAssertThrowsError(try invalid.consume(""))
        }
        var empty = AIStreamDecoder(); _ = try empty.consume("data: [DONE]"); _ = try empty.consume("")
        XCTAssertThrowsError(try empty.finish())
        var truncated = AIStreamDecoder()
        _ = try truncated.consume(#"data: {"choices":[{"delta":{"content":"last partial"},"finish_reason":"length"}]}"#)
        XCTAssertEqual(try truncated.consume(""), "last partial")
        XCTAssertThrowsError(try truncated.finish())
    }
    func testMultilineEventAndLastEventWithoutBlankLine() throws {
        var decoder = AIStreamDecoder()
        _ = try decoder.consume("\u{feff}" + #"data: {"choices":["#)
        _ = try decoder.consume(#"data: {"delta":{"content":"Original"},"finish_reason":"stop"}]}"#)
        XCTAssertEqual(try decoder.finish(), "Original")
        let request = try ServiceRequests.ai(base: "https://example.org/v1", model: "original-model", key: "", quote: "Original source", question: "Explain", translate: false, stream: true)
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        XCTAssertEqual(body["stream"] as? Bool, true)
    }
}
