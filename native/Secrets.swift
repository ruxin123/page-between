import Foundation
import Security
import LocalAuthentication

// Read-only upgrade bridge. New credentials are saved in App configuration files.
func run() throws -> [String: Any] {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 16_384,
          let request = try JSONSerialization.jsonObject(with: input) as? [String: String],
          let operation = request["operation"],
          operation == "get",
          let account = request["account"],
          account.range(of: "^(ai|mineru|translation|book-source):[a-f0-9]{32}$", options: .regularExpression) != nil,
          let profile = request["profile"], ["personal", "demo"].contains(profile)
    else { return ["error": "invalid_request"] }
    let context = LAContext()
    context.interactionNotAllowed = true
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "local.pagebetween.services." + profile,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false,
        kSecUseAuthenticationContext as String: context,
    ]
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { return ["value": NSNull()] }
    if status == errSecSuccess, let data = result as? Data,
       let value = String(data: data, encoding: .utf8) { return ["value": value] }
    return ["error": "migration_unavailable", "code": status]
}

do {
    let result = try run()
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
} catch {
    FileHandle.standardOutput.write(Data("{\"error\":\"invalid_request\"}".utf8))
}
