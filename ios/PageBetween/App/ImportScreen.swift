import SwiftUI

@MainActor final class ImportDraft: ObservableObject, Identifiable {
    let id = UUID()
    @Published var items: [BookImport]
    init(_ urls: [URL]) { items = urls.map(BookImport.init) }
}

struct ImportScreen: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var draft: ImportDraft
    let confirm: ([BookImport]) -> Void
    var body: some View {
        NavigationStack {
            Form {
                ForEach(draft.items) { item in
                    Section {
                        Toggle("文档解析", isOn: Binding(get: { draft.items.first(where: { $0.id == item.id })?.parseEnabled ?? item.parseEnabled }, set: { value in
                            if let index = draft.items.firstIndex(where: { $0.id == item.id }) { draft.items[index].parseEnabled = value }
                        })).accessibilityIdentifier("import.parse.\(item.url.lastPathComponent)")
                    } header: { Text(item.url.lastPathComponent).textCase(nil) }
                }
            }
            .navigationTitle("导入书籍").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("导入") { let choices = draft.items; dismiss(); confirm(choices) }.disabled(draft.items.isEmpty) }
            }
        }.tint(MobilePalette.accent)
    }
}
