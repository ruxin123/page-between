import SwiftUI

struct ConversationHistoryScreen: View {
    @Environment(\.dismiss) private var dismiss
    let book: MobileBook
    let repository: LibraryRepository
    let openSource: (String) -> Void
    @State private var items: [MobileConversation] = []
    @State private var selected: MobileConversation?
    @State private var error: String?
    @State private var loading = true
    @State private var more = true
    @State private var offset = 0
    var body: some View {
        NavigationStack {
            List {
                if items.isEmpty && !loading { ContentUnavailableView("暂无答疑记录", systemImage: "text.bubble") }
                ForEach(items) { item in
                    Button { selected = item } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.turns.first(where: { $0.role == "user" })?.content ?? "书内答疑").lineLimit(2).foregroundStyle(.primary)
                            Text(item.quote).font(.caption).lineLimit(2).foregroundStyle(.secondary)
                        }.padding(.vertical, 4)
                    }
                }
                if loading { ProgressView() }
                else if more && !items.isEmpty { Button("更早记录") { Task { await load() } } }
                if let error { Text(error).foregroundStyle(.secondary) }
            }
            .navigationTitle("答疑记录").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { dismiss() } }
            .task { await load() }
            .sheet(item: $selected) { conversation in
                AssistantScreen(selection: AssistantSelection(book: book.id, quote: conversation.quote, locator: conversation.locator, translate: false, markdown: conversation.previewQuote, objects: conversation.sourceObjects ?? []), title: book.title, repository: repository, initialConversation: conversation, openSource: { raw in dismiss(); openSource(raw) })
            }
        }.tint(MobilePalette.accent)
    }
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let page = try await repository.conversations(book.id, offset: offset)
            let existing = Set(items.map(\.id))
            items += page.filter { !existing.contains($0.id) }
            offset += page.count
            more = page.count == 30
        }
        catch { self.error = error.localizedDescription }
    }
}
