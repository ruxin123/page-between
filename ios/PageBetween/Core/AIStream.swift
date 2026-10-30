import Foundation

public struct AIStreamDecoder {
    public private(set) var completed = false
    private var fields: [String] = []
    private var size = 0
    private var receivedText = false
    private var failure: ServiceRequestFailure?
    public init() {}

    public mutating func consume(_ input: String) throws -> String {
        guard !completed else { return "" }
        let line = size == 0 && input.hasPrefix("\u{feff}") ? String(input.dropFirst()) : input
        size += line.utf8.count
        guard size <= 4 * 1024 * 1024 else { throw ServiceRequestFailure.invalidReply }
        if line.isEmpty { return try event() }
        if line.hasPrefix("data:") {
            let value = line.dropFirst(5)
            fields.append(String(value.first == " " ? value.dropFirst() : value))
        }
        return ""
    }
    public mutating func finish() throws -> String {
        let tail = try event()
        if let failure { throw failure }
        guard completed, receivedText else { throw ServiceRequestFailure.invalidReply }
        return tail
    }
    private mutating func event() throws -> String {
        guard !fields.isEmpty else { return "" }
        let payload = fields.joined(separator: "\n"); fields.removeAll(keepingCapacity: true)
        if payload == "[DONE]" { completed = true; return "" }
        guard let data = payload.data(using: .utf8), let body = try JSONSerialization.jsonObject(with: data) as? [String: Any], body["error"] == nil else { throw ServiceRequestFailure.invalidReply }
        guard let choices = body["choices"] as? [[String: Any]] else { throw ServiceRequestFailure.invalidReply }
        guard let choice = choices.first else { return "" }
        let delta = choice["delta"] as? [String: Any]
        let text = delta?["content"] as? String ?? ""
        if !text.isEmpty { receivedText = true }
        if let reason = choice["finish_reason"] as? String {
            if reason != "stop" { failure = .incompleteReply }
            completed = true
        }
        return text
    }
}

public enum AITransport {
    public static func stream(_ request: URLRequest, session: URLSession, onDelta: @Sendable (String) async -> Void) async throws -> String {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw ServiceRequestFailure.invalidReply }
        // Some compatible services return a complete JSON response even when streaming is requested.
        if http.value(forHTTPHeaderField: "Content-Type")?.lowercased().contains("application/json") == true {
            var data = Data()
            for try await byte in bytes { try Task.checkCancellation(); guard data.count < 4 * 1024 * 1024 else { throw ServiceRequestFailure.invalidReply }; data.append(byte) }
            let result = try ServiceRequests.answer(data)
            guard result.count <= 50000 else { throw ServiceRequestFailure.incompleteReply }
            await onDelta(result); return result
        }
        var decoder = AIStreamDecoder(), result = ""
        func append(_ text: String) async throws {
            guard result.count + text.count <= 50000 else { throw ServiceRequestFailure.incompleteReply }
            if !text.isEmpty { result += text; await onDelta(text) }
        }
        var line = Data(), received = 0
        for try await byte in bytes {
            try Task.checkCancellation()
            received += 1
            guard received <= 4 * 1024 * 1024, line.count < 512 * 1024 else { throw ServiceRequestFailure.invalidReply }
            if byte == 10 {
                if line.last == 13 { line.removeLast() }
                guard let text = String(data: line, encoding: .utf8) else { throw ServiceRequestFailure.invalidReply }
                try await append(decoder.consume(text)); line.removeAll(keepingCapacity: true)
                if decoder.completed { break }
            } else { line.append(byte) }
        }
        if !decoder.completed, !line.isEmpty {
            guard let text = String(data: line, encoding: .utf8) else { throw ServiceRequestFailure.invalidReply }
            try await append(decoder.consume(text))
        }
        try await append(decoder.finish())
        try Task.checkCancellation()
        return result
    }
}
