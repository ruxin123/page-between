import XCTest
@testable import PageBetweenCore

final class ServicesTests: XCTestCase {
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
}
