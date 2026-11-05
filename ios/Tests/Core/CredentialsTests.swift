import Foundation
import XCTest
@testable import PageBetweenCore

final class CredentialsTests: XCTestCase {
    func testFilePersistenceRemovalAndPermissions() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = CredentialFile(url: root.appendingPathComponent("credentials.json"))
        XCTAssertEqual(try file.read(), [:])
        try file.write(["ai": "original-ai", "translation": "original-translation"])
        XCTAssertEqual(try CredentialFile(url: file.url).read()["translation"], "original-translation")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try file.write(["ai": "replacement", "translation": ""])
        XCTAssertEqual(try file.read(), ["ai": "replacement", "translation": ""])
        try Data("damaged".utf8).write(to: file.url)
        XCTAssertThrowsError(try file.read())
    }
}
