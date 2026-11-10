import XCTest
@testable import PageBetweenCore

final class ServicesTests: XCTestCase {
    func testLocalModelsAndDiscoveryBounds() throws {
        for url in ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://192.168.1.20:11434/v1", "http://172.16.1.3/v1", "http://reader.local:1234/v1"] {
            XCTAssertNoThrow(try ServiceRequests.endpoint(url, allowLocalHTTP: true))
        }
        for url in ["http://example.org/v1", "http://192.test.168.1.1/v1", "http://172.32.1.3/v1", "http://192.168.1.1.example.org/v1", "http://010.0.0.1/v1"] {
            XCTAssertThrowsError(try ServiceRequests.endpoint(url, allowLocalHTTP: true))
        }
        let request = try ServiceRequests.models(base: "http://localhost:11434/v1/chat/completions", key: "")
        XCTAssertEqual(request.url?.absoluteString, "http://localhost:11434/v1/models")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(try ServiceRequests.modelNames(Data(#"{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}"#.utf8)), ["a", "b"])
        XCTAssertEqual(try ServiceRequests.modelNames(Data(#"{"data":[]}"#.utf8)), [])
        XCTAssertThrowsError(try ServiceRequests.modelNames(Data("<html>unavailable</html>".utf8))) { error in
            XCTAssertEqual(error.localizedDescription, ServiceRequestFailure.invalidReply.localizedDescription)
        }
        for invalid in [Data(#"{"data":[null]}"#.utf8), Data(repeating: 32, count: 1024 * 1024 + 1)] {
            XCTAssertThrowsError(try ServiceRequests.modelNames(invalid))
        }
    }
    func testCustomPromptKeepsSourceAndDefaultInstructions() throws {
        let quote = #"$\sigma\in S_n$"#
        let request = try ServiceRequests.ai(base: "https://example.org/v1", model: "original", key: "", quote: quote, question: "Explain", translate: false, customPrompt: "先给提示\n再展开证明")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertTrue(messages[0]["content"]!.contains("先给提示\n再展开证明"))
        XCTAssertTrue(messages[0]["content"]!.contains("不编造本书结论或出处"))
        XCTAssertEqual(messages[1]["content"], "原文：\n" + quote)
        XCTAssertThrowsError(try ServiceRequests.ai(base: "https://example.org/v1", model: "original", key: "", quote: quote, question: "", translate: true, customPrompt: String(repeating: "x", count: 4001)))
    }
    func testRequestsPreserveRawMathAndSeparateCredentialsFromContent() throws {
        let quote = #"Since an element $\sigma$ of $S_{n}$ is a function."#
        let request = try ServiceRequests.ai(base: "https://example.org/v1", model: "original-model", key: "synthetic-test-key", quote: quote, question: "Explain", translate: false)
        XCTAssertEqual(request.url?.absoluteString, "https://example.org/v1/chat/completions")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-test-key")
        let data = try XCTUnwrap(request.httpBody)
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertTrue(messages[1]["content"]!.contains(quote))
        XCTAssertFalse(String(data: data, encoding: .utf8)!.contains("synthetic-test-key"))
        for base in ["http://example.org/v1", "https://user:password@example.org", "https://example.org?key=secret", "file:///book"] { XCTAssertThrowsError(try ServiceRequests.endpoint(base)) }
    }
    func testGoogleReceivesActualFormulasAndLanguageDetectionIgnoresMathText() throws {
        let quote = #"Let $x+1\text{ 中文}$ be positive."#
        let request = try ServiceRequests.google(quote)
        let components = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "tl" })?.value, "zh-CN")
        var body = URLComponents(); body.percentEncodedQuery = String(data: request.httpBody!, encoding: .utf8)
        XCTAssertEqual(body.queryItems?.first?.value, quote)
        XCTAssertThrowsError(try ServiceRequests.google(String(repeating: "x", count: 12001)))
    }
    func testFormulaRestoreMatchesContentAcrossReorderedTranslation() {
        let source = #"Since an element $\sigma$ of $S_{n}$ acts on $S$."#
        let restored = MathText.restore(#"由于 $S_n$ 中的元素 $σ$ 作用于 $S$。"#, source: source)
        XCTAssertEqual(restored.text, #"由于 $S_{n}$ 中的元素 $\sigma$ 作用于 $S$。"#)
        XCTAssertFalse(restored.needsReview)
        let missing = MathText.restore("保留可读译文", source: source)
        XCTAssertEqual(missing.text, "保留可读译文")
        XCTAssertTrue(missing.needsReview)
    }
    func testAmbiguousNotationIsNotAssignedByPosition() {
        let result = MathText.restore("$a$ then $a$", source: #"\(a\) and $a$"#)
        XCTAssertTrue(result.needsReview)
        XCTAssertEqual(result.text, "$a$ then $a$")
        XCTAssertThrowsError(try ServiceRequests.answer(Data("{}".utf8)))
        XCTAssertThrowsError(try ServiceRequests.translated(Data(#"{"sentences":[]}"#.utf8)))
    }
    func testCurrencyIsNotTreatedAsMath() { XCTAssertTrue(MathText.spans("Prices range from $50 to $70.").isEmpty) }

    func testLongTranslationChunksPreserveFormulaAndUnicodeBoundaries() {
        let formula = "$" + String(repeating: "x+", count: 2100) + "y$"
        let text = String(repeating: "A paragraph 🪶 with words. ", count: 170) + formula + String(repeating: " Next paragraph 🪶. ", count: 220)
        let chunks = ServiceRequests.translationChunks(text)
        XCTAssertEqual(chunks.joined(), text)
        XCTAssertTrue(chunks.contains(formula))
        XCTAssertEqual(chunks.flatMap { MathText.spans($0).map(\.raw) }, [formula])
        XCTAssertTrue(chunks.allSatisfy { ($0 as NSString).length <= 4000 || $0 == formula })
        XCTAssertEqual(ServiceRequests.translationChunks(""), [])
        XCTAssertEqual(ServiceRequests.targetLanguage("这是正文 $x$"), "en")
    }
    func testImageInputUsesOnlyExplicitOriginalPNGAttachments() throws {
        let image = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfQAAAABJRU5ErkJggg==")!
        let request = try ServiceRequests.ai(base: "https://example.org/v1", model: "image-model", key: "anonymous-test-key", quote: #"x^2=\emptyset"#, question: "Explain", translate: false, images: [image])
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        let messages = body["messages"] as! [[String: Any]], content = messages[1]["content"] as! [[String: Any]]
        XCTAssertEqual(content[0]["text"] as? String, "原文：\nx^2=\\emptyset")
        XCTAssertEqual((content[1]["image_url"] as? [String: String])?["url"], "data:image/png;base64," + image.base64EncodedString())
        XCTAssertThrowsError(try ServiceRequests.ai(base: "https://example.org/v1", model: "image-model", key: "", quote: "", question: "", translate: true, images: [image]))
        XCTAssertThrowsError(try ServiceRequests.ai(base: "https://example.org/v1", model: "image-model", key: "", quote: "", question: "", translate: false, images: [Data("Not a PNG".utf8)]))
        XCTAssertThrowsError(try ServiceRequests.ai(base: "https://example.org/v1", model: "image-model", key: "", quote: "", question: "", translate: false, images: Array(repeating: image, count: 5)))
    }
}
