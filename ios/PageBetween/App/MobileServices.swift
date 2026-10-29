import Foundation
import Security
import SwiftUI

struct ServiceProfile: Codable, Equatable {
    var baseURL = "https://api.openai.com/v1"
    var model = ""
}

enum SecureKeys {
    static let service = "local.pagebetween.ios.services"
    static func read(_ name: String) -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func write(_ name: String, value: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
        if value.isEmpty { let status = SecItemDelete(query as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw ServiceError.message("无法清除凭据。") }; return }
        let attributes = [kSecValueData as String: Data(value.utf8)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new }.merging([kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw ServiceError.message("凭据未能保存，请重试。") }
    }
}

enum ServiceError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

private final class ReadingNetworkPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private let readingNetwork: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    return URLSession(configuration: configuration, delegate: ReadingNetworkPolicy(), delegateQueue: nil)
}()

@MainActor final class MobileServices: ObservableObject {
    @Published var ai = ServiceProfile()
    @Published var translation = ServiceProfile()
    @Published var separateTranslation = false
    @Published var provider = "google"
    init() { reload() }
    func reload() {
        let defaults = UserDefaults.standard
        ai = defaults.data(forKey: "services.ai").flatMap { try? JSONDecoder().decode(ServiceProfile.self, from: $0) } ?? ServiceProfile()
        translation = defaults.data(forKey: "services.translation").flatMap { try? JSONDecoder().decode(ServiceProfile.self, from: $0) } ?? ServiceProfile()
        separateTranslation = defaults.bool(forKey: "services.separateTranslation")
        provider = defaults.string(forKey: "services.provider") ?? "google"
    }
    func save(aiKey: String, translationKey: String) throws {
        _ = try Self.endpoint(ai.baseURL)
        if separateTranslation { _ = try Self.endpoint(translation.baseURL) }
        try SecureKeys.write("ai", value: aiKey)
        try SecureKeys.write("translation", value: translationKey)
        let defaults = UserDefaults.standard
        defaults.set(try JSONEncoder().encode(ai), forKey: "services.ai")
        defaults.set(try JSONEncoder().encode(translation), forKey: "services.translation")
        defaults.set(separateTranslation, forKey: "services.separateTranslation")
        defaults.set(provider, forKey: "services.provider")
    }
    static func endpoint(_ value: String) throws -> URL { try ServiceRequests.endpoint(value) }
    func complete(quote: String, question: String, translate: Bool, history: [MobileTurn] = []) async throws -> String {
        let dedicated = translate && separateTranslation && !translation.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let profile = dedicated ? translation : ai
        let request = try ServiceRequests.ai(base: profile.baseURL, model: profile.model, key: SecureKeys.read(dedicated ? "translation" : "ai"), quote: quote, question: question, translate: translate, history: history)
        let (data, response) = try await readingNetwork.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw ServiceError.message("AI 请求未完成，请检查服务配置或稍后重试。") }
        return try ServiceRequests.answer(data)
    }
    func google(_ text: String) async throws -> String {
        guard text.count <= 12000 else { throw ServiceRequestFailure.selectionTooLong }
        let target = ServiceRequests.targetLanguage(text)
        var result = ""
        for chunk in ServiceRequests.translationChunks(text) {
            try Task.checkCancellation()
            let trimmed = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || MathText.spans(trimmed).first?.raw == trimmed { result += chunk; continue }
            let leading = String(chunk.prefix(while: { $0.isWhitespace }))
            let trailing = String(chunk.reversed().prefix(while: { $0.isWhitespace }).reversed())
            let request = try ServiceRequests.google(trimmed, target: target)
            let (data, response) = try await readingNetwork.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw ServiceError.message("Google 翻译暂不可用，请重试或切换 AI。") }
            result += leading + (try ServiceRequests.translated(data)).trimmingCharacters(in: .whitespacesAndNewlines) + trailing
        }
        return result
    }
}
