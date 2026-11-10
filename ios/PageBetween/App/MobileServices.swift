import Foundation
import Security
import LocalAuthentication
import SwiftUI

struct ServiceProfile: Codable, Equatable {
    var baseURL = "https://api.openai.com/v1"
    var model = ""
    var supportsImages: Bool?
    var customPrompt: String?
}

enum LocalCredentials {
    static func file() throws -> CredentialFile {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return CredentialFile(url: root.appendingPathComponent("PageBetween/credentials.json"))
    }
    static func read(_ name: String) throws -> String {
        let file = try file()
        if FileManager.default.fileExists(atPath: file.url.path) {
            return try file.read()[name] ?? ""
        }
        var migrated: [String: String] = [:]
        let context = LAContext()
        context.interactionNotAllowed = true
        for account in ["ai", "translation", "mineru"] {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "local.pagebetween.ios.services",
                kSecAttrAccount as String: account,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
                kSecUseAuthenticationContext as String: context,
            ]
            var value: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &value)
            if status == errSecItemNotFound { continue }
            guard status == errSecSuccess, let data = value as? Data,
                  let key = String(data: data, encoding: .utf8) else {
                throw ServiceError.message("旧凭据无法自动迁移，请在设置中重新填写。")
            }
            migrated[account] = key
        }
        try file.write(migrated)
        return migrated[name] ?? ""
    }
    static func write(_ values: [String: String]) throws {
        try file().write(values)
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
    #if DEBUG
    if AIUITestProtocol.enabled { configuration.protocolClasses = [AIUITestProtocol.self] }
    #endif
    return URLSession(configuration: configuration, delegate: ReadingNetworkPolicy(), delegateQueue: nil)
}()

@MainActor final class MobileServices: ObservableObject {
    @Published var ai = ServiceProfile()
    @Published var translation = ServiceProfile()
    @Published var separateTranslation = false
    @Published var provider = "google"
    @Published var mineru = MinerUProfile()
    init() { reload() }
    func reload() {
        let defaults = UserDefaults.standard
        ai = defaults.data(forKey: "services.ai").flatMap { try? JSONDecoder().decode(ServiceProfile.self, from: $0) } ?? ServiceProfile()
        translation = defaults.data(forKey: "services.translation").flatMap { try? JSONDecoder().decode(ServiceProfile.self, from: $0) } ?? ServiceProfile()
        separateTranslation = defaults.bool(forKey: "services.separateTranslation")
        provider = defaults.string(forKey: "services.provider") ?? "google"
        mineru = defaults.data(forKey: "services.mineru").flatMap { try? JSONDecoder().decode(MinerUProfile.self, from: $0) } ?? MinerUProfile()
        #if DEBUG
        if AIUITestProtocol.enabled { ai = ServiceProfile(baseURL: "https://stream.example.invalid/v1", model: "original-fixture", supportsImages: true) }
        #endif
    }
    func save(aiKey: String, translationKey: String, mineruKey: String) throws {
        guard [ai.customPrompt, translation.customPrompt].allSatisfy({ ($0?.count ?? 0) <= 4000 }) else { throw ServiceError.message("自定义提示词请控制在 4000 字以内。") }
        _ = try Self.endpoint(ai.baseURL)
        if separateTranslation { _ = try Self.endpoint(translation.baseURL) }
        try mineru.validate()
        try LocalCredentials.write(["ai": aiKey, "translation": translationKey, "mineru": mineruKey])
        let defaults = UserDefaults.standard
        defaults.set(try JSONEncoder().encode(ai), forKey: "services.ai")
        defaults.set(try JSONEncoder().encode(translation), forKey: "services.translation")
        defaults.set(separateTranslation, forKey: "services.separateTranslation")
        defaults.set(provider, forKey: "services.provider")
        defaults.set(try JSONEncoder().encode(mineru), forKey: "services.mineru")
    }
    static func endpoint(_ value: String) throws -> URL { try ServiceRequests.endpoint(value) }
    private func request(quote: String, question: String, translate: Bool, history: [MobileTurn], images: [Data], stream: Bool) throws -> URLRequest {
        let dedicated = translate && separateTranslation && !translation.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let profile = dedicated ? translation : ai
        guard images.isEmpty || !translate && profile.supportsImages == true else { throw ServiceError.message("请配置支持图像的答疑模型。") }
        let key: String
        #if DEBUG
        key = try (AIUITestProtocol.enabled ? "" : LocalCredentials.read(dedicated ? "translation" : "ai"))
        #else
        key = try LocalCredentials.read(dedicated ? "translation" : "ai")
        #endif
        return try ServiceRequests.ai(base: profile.baseURL, model: profile.model, key: key, quote: quote, question: question, translate: translate, history: history, images: images, stream: stream, customPrompt: (translate ? translation.customPrompt : ai.customPrompt) ?? "")
    }
    func stream(quote: String, question: String, history: [MobileTurn], images: [Data], onDelta: @escaping @MainActor @Sendable (String) async -> Void) async throws -> String {
        let request = try request(quote: quote, question: question, translate: false, history: history, images: images, stream: true)
        return try await AITransport.stream(request, session: readingNetwork, onDelta: onDelta)
    }
    func complete(quote: String, question: String, translate: Bool, history: [MobileTurn] = [], images: [Data] = []) async throws -> String {
        let request = try request(quote: quote, question: question, translate: translate, history: history, images: images, stream: false)
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
