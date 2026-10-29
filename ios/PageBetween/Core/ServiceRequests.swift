import Foundation

public enum ServiceRequestFailure: LocalizedError {
    case invalidURL, missingModel, invalidReply, selectionTooLong, conversationTooLong
    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "请输入完整的 HTTPS 服务地址。"
        case .missingModel: return "请先在设置中配置 AI 模型。"
        case .invalidReply: return "服务没有返回可读内容，请重试。"
        case .selectionTooLong: return "选段过长，请缩小范围。"
        case .conversationTooLong: return "对话较长，请从原文重新提问。"
        }
    }
}

public enum ServiceRequests {
    public static func endpoint(_ value: String) throws -> URL {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw ServiceRequestFailure.invalidURL }
        return url
    }
    public static func ai(base: String, model: String, key: String, quote: String, question: String, translate: Bool, history: [MobileTurn] = []) throws -> URLRequest {
        guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ServiceRequestFailure.missingModel }
        guard quote.count <= 12000, question.count <= 6000 else { throw ServiceRequestFailure.selectionTooLong }
        guard history.count <= 40, history.reduce(0, { $0 + $1.content.count }) <= 80000, history.allSatisfy({ ["user", "assistant"].contains($0.role) }) else { throw ServiceRequestFailure.conversationTooLong }
        let base = try endpoint(base)
        let url = base.lastPathComponent == "chat" ? base.appendingPathComponent("completions") : base.lastPathComponent == "completions" ? base : base.appendingPathComponent("chat/completions")
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !key.isEmpty { request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization") }
        let system = translate ? "你是精确的书籍翻译助手。将英文译为简体中文，中文译为英文。保留原文段落、Markdown、图表和全部 LaTeX 公式，不修改数学符号与公式顺序。只输出译文。" : "你是书内辅导老师。依据提供的选段回答，保留 Markdown 与 LaTeX。明确区分选段内容与外部补充；缺乏条件时说明，不编造本书结论或出处。"
        let messages = [["role": "system", "content": system], ["role": "user", "content": "原文：\n" + quote]] + (translate ? [] : history.map { ["role": $0.role, "content": $0.content] }) + (question.isEmpty ? [] : [["role": "user", "content": question]])
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model, "messages": messages, "stream": false])
        return request
    }
    public static func translationChunks(_ text: String, maximum: Int = 4000) -> [String] {
        let source = text as NSString, formulas = MathText.spans(text)
        let limit = max(16, maximum)
        var start = 0, chunks: [String] = []
        while start < source.length {
            var end = min(start + limit, source.length)
            if end < source.length {
                let whitespace = source.rangeOfCharacter(from: .whitespacesAndNewlines, options: .backwards, range: NSRange(location: start + limit / 2, length: limit - limit / 2))
                if whitespace.location != NSNotFound { end = whitespace.location }
                if let formula = formulas.first(where: { $0.range.location < end && NSMaxRange($0.range) > end }) {
                    end = formula.range.location > start ? formula.range.location : NSMaxRange(formula.range)
                }
                if (0xD800...0xDBFF).contains(source.character(at: end - 1)) { end -= 1 }
            }
            chunks.append(source.substring(with: NSRange(location: start, length: end - start)))
            start = end
        }
        return chunks
    }
    public static func targetLanguage(_ text: String) -> String {
        MathText.prose(text).range(of: #"[\u3400-\u9fff]"#, options: .regularExpression) == nil ? "zh-CN" : "en"
    }
    public static func google(_ text: String, target: String? = nil) throws -> URLRequest {
        guard text.count <= 12000 else { throw ServiceRequestFailure.selectionTooLong }
        var components = URLComponents(string: "https://translate.google.com/translate_a/single")!
        components.queryItems = ["client": "gtx", "sl": "auto", "tl": target ?? targetLanguage(text), "dt": "t", "dj": "1"].map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: components.url!); request.httpMethod = "POST"; request.timeoutInterval = 35
        request.setValue("application/x-www-form-urlencoded;charset=UTF-8", forHTTPHeaderField: "Content-Type")
        var form = URLComponents(); form.queryItems = [URLQueryItem(name: "q", value: text)]
        request.httpBody = Data((form.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8)
        return request
    }
    public static func answer(_ data: Data) throws -> String {
        guard data.count < 4 * 1024 * 1024, let body = try JSONSerialization.jsonObject(with: data) as? [String: Any], let choices = body["choices"] as? [[String: Any]], let message = choices.first?["message"] as? [String: Any], let text = message["content"] as? String, !text.isEmpty else { throw ServiceRequestFailure.invalidReply }
        return text
    }
    public static func translated(_ data: Data) throws -> String {
        guard data.count < 4 * 1024 * 1024, let body = try JSONSerialization.jsonObject(with: data) as? [String: Any], let sentences = body["sentences"] as? [[String: Any]] else { throw ServiceRequestFailure.invalidReply }
        let text = sentences.compactMap { $0["trans"] as? String }.joined()
        guard !text.isEmpty else { throw ServiceRequestFailure.invalidReply }
        return text
    }
}
