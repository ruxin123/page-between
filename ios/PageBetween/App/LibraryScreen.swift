import SwiftUI
import UniformTypeIdentifiers

enum MobilePalette {
    static let paper = Color(UIColor { trait in trait.userInterfaceStyle == .dark ? UIColor(red: 0.078, green: 0.118, blue: 0.098, alpha: 1) : UIColor(red: 0.985, green: 0.981, blue: 0.963, alpha: 1) })
    static let ink = Color(red: 0.11, green: 0.17, blue: 0.14)
    static let accent = Color(red: 0.29, green: 0.45, blue: 0.37)
}

struct LibraryScreen: View {
    @ObservedObject var store: LibraryStore
    @State private var search = ""
    @State private var importing = false
    @State private var settings = false
    @State private var removed = false
    @State private var selected: MobileBook?
    @State private var deleting: MobileBook?
    @State private var pinnedOnly = false
    private var books: [MobileBook] {
        store.books.filter { ($0.deletedAt != nil) == removed && (!pinnedOnly || $0.pinned) && (search.isEmpty || ($0.title + $0.author).localizedCaseInsensitiveContains(search)) }.sorted { ($0.lastOpened ?? $0.importedAt) > ($1.lastOpened ?? $1.importedAt) }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if !removed, let recent = books.first(where: { $0.progress > 0 }) {
                        Button { selected = recent } label: {
                            HStack(spacing: 16) {
                                Image(systemName: "book.pages").font(.system(size: 32)).frame(width: 56)
                                VStack(alignment: .leading, spacing: 8) { Text("继续阅读").font(.caption); Text(recent.title).font(.headline).lineLimit(2); Text(recent.chapter).font(.caption).lineLimit(1) }
                                Spacer(); Image(systemName: "arrow.right")
                            }.padding(20).background(MobilePalette.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 18))
                        }.buttonStyle(.plain)
                    }
                    HStack { Text(removed ? "最近删除" : "我的书籍").font(.title3.bold()); Spacer(); if !removed { Toggle("常读", isOn: $pinnedOnly).toggleStyle(.button).font(.caption) } }
                    if books.isEmpty {
                        VStack(spacing: 16) {
                            ContentUnavailableView(removed ? "没有已删除的书籍" : pinnedOnly ? "还没有常读书籍" : search.isEmpty ? "带一本书进来" : "没有找到书籍", systemImage: "books.vertical", description: Text(removed ? "删除的书籍会在这里保留。" : pinnedOnly ? "长按封面，加入常读。" : search.isEmpty ? "从“文件”导入 EPUB、PDF 或 TXT。" : "试试其他书名或作者。"))
                            if search.isEmpty && !removed && !pinnedOnly { Button("导入书籍") { importing = true }.buttonStyle(.borderedProminent) }
                        }.padding(.vertical, 32)
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: 20)], alignment: .leading, spacing: 28) {
                            ForEach(books) { book in
                                Button { if removed { Task { await store.remove(book, deleted: false) } } else { selected = book } } label: {
                                    VStack(alignment: .leading, spacing: 10) {
                                        MobileBookCover(book: book, url: store.coverURL(book))
                                        Text(book.title).font(.subheadline.weight(.medium)).lineLimit(2)
                                        HStack { Text(removed ? "点按恢复" : book.progress > 0 ? "\(Int(book.progress * 100))%" : book.format.uppercased()); Spacer(); if book.pinned { Image(systemName: "star.fill") } }.font(.caption).foregroundStyle(.secondary)
                                    }
                                }.buttonStyle(.plain).contextMenu {
                                    if removed { Button("恢复", systemImage: "arrow.uturn.backward") { Task { await store.remove(book, deleted: false) } } }
                                    else {
                                        Button(book.pinned ? "移出常读" : "加入常读", systemImage: "star") { var updated = book; updated.pinned.toggle(); Task { await store.save(updated) } }
                                        Button("删除书籍", systemImage: "trash", role: .destructive) { deleting = book }
                                    }
                                }
                            }
                        }
                    }
                }.padding(24)
            }
            .background(MobilePalette.paper)
            .navigationTitle("页间")
            .searchable(text: $search, prompt: "书名、作者")
            .toolbar { ToolbarItemGroup(placement: .topBarTrailing) {
                if store.importing { ProgressView() }
                else { Button("导入", systemImage: "plus") { importing = true } }
                Menu { Button(removed ? "返回书库" : "最近删除", systemImage: "trash") { removed.toggle(); pinnedOnly = false; search = "" }; Button("设置", systemImage: "gearshape") { settings = true } } label: { Image(systemName: "ellipsis.circle") }.accessibilityIdentifier("library.more")
            } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [UTType(filenameExtension: "epub")!, .pdf, .plainText, UTType(filenameExtension: "cbz") ?? .zip], allowsMultipleSelection: true) { result in
                switch result { case .success(let urls): Task { await store.importFiles(urls) }; case .failure(let error): store.error = error.localizedDescription }
            }
            .fullScreenCover(item: $selected) { book in ReaderScreen(book: book, store: store) }
            .sheet(isPresented: $settings) { MobileSettingsScreen() }
            .confirmationDialog("删除这本书？可在“最近删除”恢复。", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button("删除书籍", role: .destructive) { if let book = deleting { Task { await store.remove(book, deleted: true) } }; deleting = nil }
            }
            .alert("操作未完成", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) { Button("好") { store.error = nil } } message: { Text(store.error ?? "") }
            .task { await store.refresh() }
            .onOpenURL { url in Task { await store.importFiles([url]) } }
        }.tint(MobilePalette.accent)
    }
}

private struct MobileBookCover: View {
    let book: MobileBook
    let url: URL
    @State private var image: UIImage?
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: geometry.size.width, height: geometry.size.height).clipped()
                } else {
                    VStack(alignment: .leading) {
                        Text(book.format.uppercased()).font(.caption2.monospaced())
                        Spacer()
                        Text(book.title).font(.system(.title3, design: .serif).weight(.medium)).lineLimit(4)
                        Spacer()
                        Text(book.author.isEmpty ? "页间" : book.author).font(.caption2).lineLimit(1)
                    }.padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                }
                LinearGradient(colors: [.white.opacity(0.12), .black.opacity(0.08), .clear], startPoint: .leading, endPoint: .trailing).frame(width: 12)
            }.foregroundStyle(.white.opacity(0.92)).background(book.format == "pdf" ? Color(red: 0.32, green: 0.41, blue: 0.49) : MobilePalette.accent)
        }
        .aspectRatio(0.72, contentMode: .fit)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 3, bottomLeadingRadius: 3, bottomTrailingRadius: 10, topTrailingRadius: 10))
        .accessibilityHidden(true)
        .task(id: url) { image = await Task.detached(priority: .utility) { UIImage(contentsOfFile: url.path) }.value }
    }
}
