import SwiftUI

struct AssistantScreen: View {
    @Environment(\.dismiss) private var dismiss
    let selection: AssistantSelection
    let title: String
    let repository: LibraryRepository
    var initialConversation: MobileConversation? = nil
    var openSource: ((String) -> Void)? = nil
    @StateObject private var services = MobileServices()
    @State private var question = ""
    @State private var answer = ""
    @State private var error: String?
    @State private var formulaReview = false
    @State private var busy = false
    @State private var request: Task<Void, Never>?
    @State private var conversation: MobileConversation?
    @State private var turns: [MobileTurn] = []
    @State private var settings = false
    @State private var sourceImages: [MarkdownSourceImage] = []
    @State private var sendImage = false
    @State private var lastSavedAt = Date.distantPast
    @FocusState private var questionFocused: Bool
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1); Spacer(); if let openSource { Button("返回原文", systemImage: "arrow.up.right.square") { request?.cancel(); dismiss(); openSource(selection.locator) }.labelStyle(.iconOnly) }; Button("复制原文", systemImage: "doc.on.doc") { UIPasteboard.general.string = selection.quote }.labelStyle(.iconOnly) }
                        if !selection.quote.isEmpty { MarkdownView(text: selection.markdown ?? selection.quote, images: sourceImages) }
                        ForEach(Array(selection.objects.enumerated()), id: \.offset) { index, object in
                            if object.type == "image", index < sourceImages.count, let image = UIImage(data: sourceImages[index].data) { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("原书图像") }
                        }
                    }.padding(16).background(MobilePalette.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
                    if selection.translate {
                        Picker("翻译服务", selection: $services.provider) { Text("Google 翻译").tag("google"); Text("AI 翻译").tag("ai") }.pickerStyle(.segmented)
                    } else {
                        if !selection.objects.isEmpty { Toggle("附带原图", isOn: $sendImage).disabled(services.ai.supportsImages != true) }
                        TextField("想问什么？", text: $question, axis: .vertical).focused($questionFocused).accessibilityIdentifier("assistant.question").lineLimit(2...6).padding(14).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                    }
                    HStack { Button(selection.translate ? "重新翻译" : "发送提问") { run() }.buttonStyle(.borderedProminent).disabled(busy || !selection.translate && question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty); if busy { ProgressView(); Button("停止") { request?.cancel() } }; Spacer(); if !answer.isEmpty || !turns.isEmpty { Button("复制结果", systemImage: "doc.on.doc") { UIPasteboard.general.string = selection.translate ? answer : turns.last(where: { $0.role == "assistant" })?.content }.labelStyle(.iconOnly) } }
                    if let error { Text(error).font(.callout).foregroundStyle(.secondary) }
                    if formulaReview { Label("部分公式请对照原文", systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
                    if !answer.isEmpty { MarkdownView(text: answer, images: sourceImages) }
                    ForEach(turns) { turn in
                        HStack {
                            if turn.role == "user" { Spacer(minLength: 32) }
                            VStack(alignment: .leading, spacing: 8) {
                                if turn.imageAttached == true { Image(systemName: "photo").accessibilityLabel("已附原图") }
                                if !turn.content.isEmpty { MarkdownView(text: turn.content, images: sourceImages) }
                                if turn.status == "stopped" { Text("已停止").font(.caption).foregroundStyle(.secondary) }
                                if let message = turn.error { Text(message).font(.caption).foregroundStyle(.secondary) }
                                if turn.id == turns.last?.id, ["stopped", "error"].contains(turn.status ?? "") { Button("重新生成") { run(retry: true) }.disabled(busy) }
                            }.padding(12).background(turn.role == "user" ? MobilePalette.accent.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 12))
                            if turn.role != "user" { Spacer(minLength: 0) }
                        }
                    }
                }.padding(20)
            }
            .navigationTitle(selection.translate ? "翻译" : "书内答疑").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("服务设置", systemImage: "gearshape") { settings = true } }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { request?.cancel(); dismiss() } }
            }
            .sheet(isPresented: $settings, onDismiss: { services.reload() }) { MobileSettingsScreen() }
            .task {
                if let initialConversation { conversation = initialConversation; turns = initialConversation.turns }
                if !selection.objects.isEmpty {
                    do {
                        guard let book = await repository.books().first(where: { $0.id == selection.book }) else { throw LibraryFailure.missingBook }
                        let original = try await repository.file(book, name: book.originalName)
                        let objects = selection.objects
                        let images = try await Task.detached {
                            try objects.map { object in (PDFTextAlignment.standaloneFormula(object.text) ?? object.text, try PDFSourceContent.image(object, original: original)) }
                        }.value
                        try Task.checkCancellation()
                        sourceImages = images.map { MarkdownSourceImage(raw: $0.0, data: $0.1) }
                    } catch is CancellationError {} catch { self.error = "原图暂时无法读取，可返回原文查看。" }
                }
                if selection.translate { run() }
            }
            .onDisappear { request?.cancel() }
        }.tint(MobilePalette.accent)
    }
    private func persist() async {
        guard !selection.translate else { return }
        var item = conversation ?? MobileConversation(book: selection.book, quote: selection.quote, locator: selection.locator)
        item.previewQuote = selection.markdown; item.sourceObjects = selection.objects
        item.turns = turns; item.updatedAt = Date(); conversation = item; lastSavedAt = Date()
        do { try await repository.saveConversation(item) }
        catch { self.error = "记录未保存：" + error.localizedDescription }
    }
    private func run(retry: Bool = false) {
        guard !busy else { return }
        guard !selection.translate || !selection.quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "所选内容没有可翻译的文字。"; return }
        let sentQuestion: String
        var history = turns
        if retry {
            guard history.count >= 2, history[history.count - 2].role == "user", history.last?.role == "assistant" else { return }
            sentQuestion = history[history.count - 2].content
            history.removeLast(2)
        } else { sentQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard selection.translate || !sentQuestion.isEmpty else { return }
        guard selection.translate || history.count <= 38 else { error = ServiceRequestFailure.conversationTooLong.localizedDescription; return }
        questionFocused = false
        busy = true; error = nil; formulaReview = false
        request = Task {
            var assistantIndex: Int?
            do {
                let text: String
                if !selection.translate && selection.quote.isEmpty && !sendImage { throw ServiceError.message("所选内容没有文字，请使用支持图像的模型并附带原图。") }
                if sendImage && sourceImages.count != selection.objects.count { throw ServiceError.message("原图尚未准备完成。") }
                if selection.translate {
                    if services.provider == "google" { text = try await services.google(selection.quote) }
                    else { text = try await services.complete(quote: selection.quote, question: sentQuestion, translate: true) }
                    try Task.checkCancellation()
                    let restored = MathText.restore(text, source: selection.quote)
                    answer = restored.text; formulaReview = restored.needsReview
                } else {
                    var user = MobileTurn(role: "user", content: sentQuestion)
                    user.imageAttached = sendImage
                    var assistant = MobileTurn(role: "assistant", content: ""); assistant.status = "generating"
                    turns = history + [user, assistant]
                    let index = turns.count - 1; assistantIndex = index
                    question = ""
                    await persist()
                    text = try await services.stream(quote: selection.quote, question: sentQuestion, history: history.filter { $0.role != "assistant" || !$0.content.isEmpty }, images: sendImage ? sourceImages.map(\.data) : []) { fragment in
                        guard !Task.isCancelled else { return }
                        turns[index].content += fragment
                        if Date().timeIntervalSince(lastSavedAt) >= 0.5 { await persist() }
                    }
                    try Task.checkCancellation()
                    turns[index].content = text; turns[index].status = "complete"
                    await persist()
                }
            } catch {
                if let index = assistantIndex {
                    turns[index].status = Task.isCancelled ? "stopped" : "error"
                    turns[index].error = Task.isCancelled ? nil : error.localizedDescription
                    await persist()
                } else if !Task.isCancelled { self.error = error.localizedDescription }
            }
            busy = false
        }
    }
}
