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
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1); Spacer(); if let openSource { Button("返回原文", systemImage: "arrow.up.right.square") { request?.cancel(); dismiss(); openSource(selection.locator) }.labelStyle(.iconOnly) }; Button("复制原文", systemImage: "doc.on.doc") { UIPasteboard.general.string = selection.quote }.labelStyle(.iconOnly) }
                        MarkdownView(text: selection.quote)
                    }.padding(16).background(MobilePalette.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
                    if selection.translate {
                        Picker("翻译服务", selection: $services.provider) { Text("Google 翻译").tag("google"); Text("AI 翻译").tag("ai") }.pickerStyle(.segmented)
                    } else {
                        TextField("想问什么？", text: $question, axis: .vertical).lineLimit(2...6).padding(14).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                    }
                    HStack { Button(selection.translate ? "重新翻译" : "发送提问") { run() }.buttonStyle(.borderedProminent).disabled(busy || !selection.translate && question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty); if busy { ProgressView(); Button("停止") { request?.cancel(); busy = false } }; Spacer(); if !answer.isEmpty || !turns.isEmpty { Button("复制结果", systemImage: "doc.on.doc") { UIPasteboard.general.string = selection.translate ? answer : turns.last(where: { $0.role == "assistant" })?.content }.labelStyle(.iconOnly) } }
                    if let error { Text(error).font(.callout).foregroundStyle(.secondary) }
                    if formulaReview { Label("部分公式请对照原文", systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
                    if !answer.isEmpty { MarkdownView(text: answer) }
                    ForEach(turns) { turn in VStack(alignment: .leading, spacing: 8) { Text(turn.role == "user" ? "你" : "AI").font(.caption).foregroundStyle(.secondary); MarkdownView(text: turn.content) } }
                }.padding(20)
            }
            .navigationTitle(selection.translate ? "翻译" : "书内答疑").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("服务设置", systemImage: "gearshape") { settings = true } }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { request?.cancel(); dismiss() } }
            }
            .sheet(isPresented: $settings, onDismiss: { services.reload() }) { MobileSettingsScreen() }
            .task { if let initialConversation { conversation = initialConversation; turns = initialConversation.turns }; if selection.translate { run() } }
            .onDisappear { request?.cancel() }
        }.tint(MobilePalette.accent)
    }
    private func run() {
        request?.cancel(); busy = true; error = nil; formulaReview = false
        request = Task {
            let sentQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
            do {
                let text: String
                if selection.translate && services.provider == "google" { text = try await services.google(selection.quote) }
                else { text = try await services.complete(quote: selection.quote, question: sentQuestion, translate: selection.translate, history: turns) }
                try Task.checkCancellation()
                if selection.translate {
                    let restored = MathText.restore(text, source: selection.quote)
                    answer = restored.text; formulaReview = restored.needsReview
                } else {
                    turns += [MobileTurn(role: "user", content: sentQuestion), MobileTurn(role: "assistant", content: text)]
                    question = ""
                    var item = conversation ?? MobileConversation(book: selection.book, quote: selection.quote, locator: selection.locator)
                    item.turns = turns; item.updatedAt = Date(); conversation = item
                    do { try await repository.saveConversation(item) }
                    catch { self.error = "回答已生成，但记录未保存：" + error.localizedDescription }
                }
            } catch is CancellationError {} catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            if !Task.isCancelled { busy = false }
        }
    }
}
