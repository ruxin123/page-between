import XCTest
@testable import PageBetweenCore

final class MinerUTests: XCTestCase {
    let sourceDigest = String(repeating: "a", count: 64)
    func layout(_ indexes: [Any] = [1,0]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["pdf_info": indexes.map { index in ["page_idx": index, "page_size": [600,800], "para_blocks": [
            ["type": "title", "level": 2, "bbox": [40,50,500,80], "lines": [["spans": [["type": "text", "content": "Original heading"]]]]],
            ["type": "text", "bbox": [40,90,500,130], "lines": [["spans": [["type": "text", "content": "An element "], ["type": "inline_equation", "content": #"\sigma\in S_n"#], ["type": "text", "content": " is a function."]]]]],
            ["type": "interline_equation", "bbox": [40,140,500,180], "lines": [["spans": [["type": "interline_equation", "content": #"\overline{a}(\bar{b}\bar{c})=\overline{abc}"#]]]]],
            ["type": "table", "bbox": [40,200,500,280], "blocks": [["lines": [["spans": [["html": "<table><tr><td>Original</td></tr></table>"]]]]]]],
            ["type": "image", "bbox": [40,300,500,500]]
        ]] }])
    }
    func testNormalizationMapsSubsetPagesAndPreservesRawFormulaAndTable() throws {
        let result = try MinerUProtocol.normalize(layout(), pages: [31,52], sourceHash: sourceDigest)
        XCTAssertEqual(result.map(\.page), [31,52])
        XCTAssertEqual(result[0].blocks[1].text, #"An element $\sigma\in S_n$ is a function."#)
        XCTAssertEqual(result[0].blocks[2].text, #"\overline{a}(\bar{b}\bar{c})=\overline{abc}"#)
        XCTAssertEqual(result[0].blocks[0].headingLevel, 2)
        XCTAssertEqual(result[1].blocks[3].tableHTML, "<table><tr><td>Original</td></tr></table>")
        XCTAssertEqual(result[1].blocks[4].type, "image")
        XCTAssertEqual(result[0].blocks[0].id, "p31-b0")
        XCTAssertEqual(result[0].blocks[0].box.left, 40.0 / 600)
        XCTAssertTrue(result.allSatisfy(\.mineruCompleted))
    }
    func testMissingDuplicateBooleanAndOutOfBoundsResultsRejectWholeBatch() throws {
        let cases: [[Any]] = [[0], [0,0], [0,2], [0,true], [0,0.5]]
        for indexes in cases { XCTAssertThrowsError(try MinerUProtocol.normalize(layout(indexes), pages: [31,52], sourceHash: sourceDigest)) }
        var body = try JSONSerialization.jsonObject(with: layout([0])) as! [String: Any]
        var pages = body["pdf_info"] as! [[String: Any]], blocks = pages[0]["para_blocks"] as! [[String: Any]]
        blocks[0]["bbox"] = [0,0,900,800]; pages[0]["para_blocks"] = blocks; body["pdf_info"] = pages
        XCTAssertThrowsError(try MinerUProtocol.normalize(JSONSerialization.data(withJSONObject: body), pages: [31], sourceHash: sourceDigest))
    }
    func testAPIAndResourcePolicyKeepCredentialsAwayFromSignedURLs() throws {
        let profile = MinerUProfile()
        let request = try MinerUProtocol.request(profile: profile, key: "anonymous-test-token")
        XCTAssertEqual(request.url?.path, "/api/v4/file-urls/batch")
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        XCTAssertEqual(body["enable_formula"] as? Bool, true)
        XCTAssertEqual(body["enable_table"] as? Bool, true)
        XCTAssertEqual(try MinerUProtocol.request(profile: profile, key: "anonymous", batch: "safe-batch_1").url?.path, "/api/v4/extract-results/batch/safe-batch_1")
        XCTAssertThrowsError(try MinerUProtocol.request(profile: profile, key: ""))
        XCTAssertThrowsError(try MinerUProtocol.request(profile: profile, key: "anonymous", batch: "../other"))
        for value in ["https://mineru.net.evil.invalid/a", "http://mineru.net/a", "https://user:password@mineru.net/a", "https://127.0.0.1/a"] { XCTAssertThrowsError(try MinerUProtocol.resource(value, base: profile.baseURL)) }
        XCTAssertEqual(try MinerUProtocol.resource("https://files.mineru.net/a?signature=anonymous", base: profile.baseURL).host, "files.mineru.net")
        XCTAssertEqual(try MinerUProtocol.resource("https://my-service.invalid/file", base: "https://my-service.invalid/api/v4").host, "my-service.invalid")
        XCTAssertThrowsError(try MinerUProtocol.reply(Data(#"{"code":true,"data":{}}"#.utf8)))
    }
    func testInterruptedBatchesSurviveRestartWithoutStoringToken() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("anonymous.pdf"); try Data("anonymous PDF bytes".utf8).write(to: source)
        let repo = try LibraryRepository(root: root.appendingPathComponent("Library")), book = try await repo.importFile(source)
        var state = MinerUCheckpoint(book: book, pages: Array(1...301), profile: MinerUProfile())
        var first = MinerUBatch(pages: Array(1...150)); first.id = "existing-batch"; first.uploaded = true; first.published = true
        state.batches = [first, MinerUBatch(pages: Array(151...300))]; state.task.completed = first.pages; state.task.state = "running"
        try await repo.saveMinerUCheckpoint(state)
        let restarted = try LibraryRepository(root: root.appendingPathComponent("Library"))
        let restored = try await restarted.mineruCheckpoint(book.id)
        XCTAssertEqual(restored?.task.state, "paused"); XCTAssertEqual(restored?.task.completed.count, 150)
        XCTAssertEqual(restored?.batches.first?.id, "existing-batch")
        state.batches[1].pages[0] = 150
        do { try await repo.saveMinerUCheckpoint(state); XCTFail("Overlapping pages accepted") } catch {}
    }
}
