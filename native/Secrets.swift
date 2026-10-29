import Foundation
import Security

// Secrets travel over stdin/stdout pipes, never process arguments or log messages.
func run() throws -> [String: Any] {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 16_384,
          let request = try JSONSerialization.jsonObject(with: input) as? [String: String],
          let operation = request["operation"],
          ["get", "set", "delete"].contains(operation),
          let account = request["account"],
          account.range(of: "^(ai|mineru|translation|book-source):[a-f0-9]{32}$", options: .regularExpression) != nil,
          let profile = request["profile"], ["personal", "demo"].contains(profile)
    else { return ["error": "invalid_request"] }
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "local.pagebetween.services." + profile,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false,
    ]
    var status: OSStatus
    if operation == "get" {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return ["value": NSNull()] }
        if status == errSecSuccess, let data = result as? Data,
           let value = String(data: data, encoding: .utf8) { return ["value": value] }
    } else if operation == "delete" {
        status = SecItemDelete(query as CFDictionary)
        if status == errSecItemNotFound { status = errSecSuccess }
    } else {
        guard let value = request["value"], !value.isEmpty, value.utf8.count <= 8192
        else { return ["error": "invalid_value"] }
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        status = SecItemAdd(item as CFDictionary, nil)
    }
    return status == errSecSuccess ? ["ok": true] : ["error": "keychain", "code": status]
}

do {
    let result = try run()
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
} catch {
    FileHandle.standardOutput.write(Data("{\"error\":\"invalid_request\"}".utf8))
}
