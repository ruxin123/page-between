import SwiftUI
import ReadiumZIPFoundation

struct ExcerptsScreen: View {
    @Environment(\.dismiss) private var dismiss
    let book: MobileBook
    let repository: LibraryRepository
    let openSource: (String) -> Void
    @State private var items: [SavedExcerpt] = []
    @State private var selected: SavedExcerpt?
    @State private var removed: SavedExcerpt?
    @State private var chapter = ""
    @State private var error: String?
    @State private var exported: URL?
    @State private var exporting = false
    @State private var folder = FileManager.default.temporaryDirectory.appendingPathComponent("excerpts-" + UUID().uuidString)
    var body: some View {
        NavigationStack {
            List {
                if !items.isEmpty {
                    Picker("章节", selection: $chapter) {
                        Text("全部章节").tag("")
                        ForEach(Array(Set(items.map(\.chapter))).sorted(), id: \.self) { Text($0).tag($0) }
                    }
                }
                ForEach(items.filter { chapter.isEmpty || $0.chapter == chapter }) { item in
                    Button { selected = item } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.quote.isEmpty ? "原文图像" : item.quote).lineLimit(3).foregroundStyle(.primary)
                            Text(item.chapter).font(.caption).foregroundStyle(Color.secondary)
                            if !item.note.isEmpty { Text(item.note).font(.callout).foregroundStyle(.primary).lineLimit(2) }
                        }.padding(.vertical, 8)
                    }.accessibilityIdentifier("excerpt.row." + item.id.uuidString).swipeActions {
                        Button("删除", role: .destructive) { Task { await remove(item) } }
                    }
                }
                if items.isEmpty { ContentUnavailableView("暂无保存选段", systemImage: "text.badge.plus") }
                if let removed { Button("撤销删除") { Task { var item = removed; item.deletedAt = nil; await save(item); self.removed = nil } } }
                if let error { Text(error).foregroundStyle(.secondary) }
                if let exported { ShareLink("存储或分享导出", item: exported) }
            }
            .navigationTitle("页边").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu("导出", systemImage: "square.and.arrow.up") {
                        Button("Markdown") { Task { await export(markdown: true) } }
                        Button("JSON") { Task { await export(markdown: false) } }
                    }.disabled(exporting || items.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .task { await reload() }
            .sheet(item: $selected) { item in
                ExcerptDetail(book: book, repository: repository, item: item, save: { value in await save(value) }, remove: { await remove(item); selected = nil }, openSource: { dismiss(); openSource(item.locator) })
            }
            .onDisappear { try? FileManager.default.removeItem(at: folder) }
        }.tint(MobilePalette.accent)
    }
    private func reload() async {
        items = await repository.books().first(where: { $0.id == book.id })?.excerpts?.filter { $0.deletedAt == nil } ?? []
    }
    @discardableResult private func save(_ item: SavedExcerpt) async -> Bool {
        do { try await repository.saveExcerpt(book.id, excerpt: item); await reload(); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    private func remove(_ item: SavedExcerpt) async {
        var deleted = item
        deleted.deletedAt = Date()
        do { try await repository.saveExcerpt(book.id, excerpt: deleted); removed = item; await reload() }
        catch { self.error = error.localizedDescription }
    }
    private func export(markdown: Bool) async {
        exporting = true
        defer { exporting = false }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let original = try await repository.file(book, name: book.originalName)
            let chosen = items.filter { chapter.isEmpty || $0.chapter == chapter }
            var size = chosen.reduce(0) { $0 + $1.quote.utf8.count + $1.note.utf8.count + ($1.answer?.utf8.count ?? 0) }
            guard size <= (markdown ? 200 : 50) * 1024 * 1024 else { throw ServiceError.message("记录较多，请按章节导出。") }
            var data = try JSONSerialization.jsonObject(with: JSONEncoder().encode(chosen)) as? [[String: Any]] ?? []
            var lines = ["# " + book.title, ""]
            let exportFolder = folder.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: exportFolder, withIntermediateDirectories: true)
            let target = exportFolder.appendingPathComponent("页边" + (markdown ? ".zip" : ".json"))
            let archive = markdown ? try await Archive(url: target, accessMode: .create) : nil
            for (index, item) in chosen.enumerated() {
                lines += ["## " + item.chapter, "", item.markdown ?? item.quote, ""]
                var images: [String] = []
                for (offset, object) in item.objects.enumerated() {
                    let bytes = try PDFSourceContent.image(object, original: original)
                    size += markdown ? bytes.count : bytes.count * 4 / 3
                    guard size <= (markdown ? 200 : 50) * 1024 * 1024 else { throw ServiceError.message("原图较多，请减少导出范围或改用 Markdown 文件包。") }
                    if !markdown { images.append("data:image/png;base64," + bytes.base64EncodedString()) }
                    if let archive {
                        let name = "images/\(index)-\(offset).png"
                        let file = folder.appendingPathComponent("\(index)-\(offset).png")
                        try bytes.write(to: file, options: .atomic)
                        try await archive.addEntry(with: name, fileURL: file)
                        lines += ["![原图](\(name))", ""]
                    }
                }
                data[index]["images"] = images
                if !item.note.isEmpty { lines += ["### 笔记", "", item.note, ""] }
                if let answer = item.answer { lines += ["### 译文或答疑", "", answer, ""] }
            }
            if let archive {
                let file = folder.appendingPathComponent("页边.md")
                try Data(lines.joined(separator: "\n").utf8).write(to: file, options: .atomic)
                try await archive.addEntry(with: "页边.md", fileURL: file)
            } else {
                let json = try JSONSerialization.data(withJSONObject: ["schema": 1, "title": book.title, "excerpts": data], options: [.prettyPrinted, .sortedKeys])
                try json.write(to: target, options: .atomic)
            }
            exported = target
        } catch { self.error = error.localizedDescription }
    }
}

private struct ExcerptDetail: View {
    @Environment(\.dismiss) private var dismiss
    let book: MobileBook
    let repository: LibraryRepository
    @State var item: SavedExcerpt
    let save: (SavedExcerpt) async -> Bool
    let remove: () async -> Void
    let openSource: () -> Void
    @State private var images: [MarkdownSourceImage] = []
    @State private var error: String?
    @State private var loading = true
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if loading { ProgressView() }
                    else {
                        Text(item.chapter).font(.caption).foregroundStyle(.secondary)
                        let source = item.markdown ?? item.quote
                        if !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { MarkdownView(text: source, images: images) }
                        ForEach(Array(item.objects.enumerated()), id: \.offset) { index, object in
                            if object.type == "image", index < images.count, let image = UIImage(data: images[index].data) { Image(uiImage: image).resizable().scaledToFit() }
                        }
                        if let answer = item.answer, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { MarkdownView(text: answer, images: images) }
                        TextField("笔记", text: $item.note, axis: .vertical).lineLimit(3...8).accessibilityIdentifier("excerpt.note").textFieldStyle(.roundedBorder)
                        HStack {
                            Button("保存笔记") { Task { if await save(item) { dismiss() } else { error = "笔记未保存，请重试。" } } }.buttonStyle(.borderedProminent)
                            Button("返回原文") { dismiss(); openSource() }
                            Spacer()
                            Button("删除", role: .destructive) { Task { await remove(); dismiss() } }
                        }
                        if let error { Text(error).foregroundStyle(.secondary) }
                    }
                }.padding(20)
            }
            .navigationTitle("选段").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { dismiss() } }
            .task {
                defer { loading = false }
                do {
                    let original = try await repository.file(book, name: book.originalName)
                    images = try item.objects.map { MarkdownSourceImage(raw: PDFTextAlignment.standaloneFormula($0.text) ?? $0.text, data: try PDFSourceContent.image($0, original: original)) }
                } catch { self.error = error.localizedDescription }
            }
        }
    }
}
