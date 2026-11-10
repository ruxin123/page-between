import SwiftUI
import ReadiumShared
import ReadiumNavigator
import WebKit

struct AssistantSelection: Identifiable {
    let id = UUID()
    let book: UUID
    let quote: String
    let locator: String
    let translate: Bool
    var markdown: String? = nil
    var objects: [PDFSourceObject] = []
    var rects: [PDFSelectionRect] = []
}

@MainActor final class MobileReader: NSObject, ObservableObject, EPUBNavigatorDelegate, PDFNavigatorDelegate {
    @Published var controller: UIViewController?
    @Published var publication: Publication?
    @Published var contents: [ReadiumShared.Link] = []
    @Published var chapter = ""
    @Published var progress = 0.0
    @Published var notice: String?
    @Published var failure: String?
    @Published var selection: AssistantSelection?
    @Published var lastSelection: AssistantSelection?
    @Published var fontScale = 100.0
    @Published var fontFamily = ""
    @Published var scroll = false
    @Published var theme = "paper"
    @Published var history: [Locator] = []
    @Published var chromeVisible = false
    @Published var lineHeight = 1.85
    @Published var pageMargins = 1.0
    @Published var bookmarked = false
    var navigator: Navigator?
    let store: LibraryStore
    let book: MobileBook
    private var saveTask: Task<Void, Never>?
    private var loaded = false
    private var directionalNavigation: DirectionalNavigationAdapter?
    private var chromeTask: Task<Void, Never>?
    private var selectionMenuTask: Task<Void, Never>?
    private var lastContentTap = 0.0

    init(book: MobileBook, store: LibraryStore) {
        self.book = book; self.store = store
        super.init()
        let defaults = UserDefaults.standard
        fontScale = defaults.object(forKey: "reading.fontScale") == nil ? 100 : min(200, max(70, defaults.double(forKey: "reading.fontScale")))
        if let value = defaults.object(forKey: "reading.lineHeight") as? Double, value.isFinite { lineHeight = min(2.2, max(1.4, value)) }
        if let value = defaults.object(forKey: "reading.pageMargins") as? Double, value.isFinite { pageMargins = min(2, max(0.5, value)) }
        fontFamily = defaults.string(forKey: "reading.fontFamily") ?? ""
        theme = defaults.string(forKey: "reading.theme") ?? "paper"
        let key = book.format == "pdf" ? "reading.pdfScroll" : "reading.textScroll"
        scroll = defaults.object(forKey: key) == nil ? book.format == "pdf" : defaults.bool(forKey: key)
        if let saved = book.appearance, saved.isValid {
            fontScale = saved.fontScale
            lineHeight = saved.lineHeight
            pageMargins = saved.pageMargins
            fontFamily = saved.fontFamily
            theme = saved.theme
            scroll = saved.scroll
        }
    }
    func load() async {
        guard !loaded else { return }; loaded = true
        do {
            let publication = try await store.open(book)
            self.publication = publication
            contents = (try? await publication.tableOfContents().get()) ?? []
            let locator = try book.locator.flatMap { try Locator(jsonString: $0) }
            let actions = [EditingAction.lookup, .share, EditingAction(title: "复制", action: #selector(ReaderHost.copySelection)), EditingAction(title: "提问", action: #selector(ReaderHost.askSelection)), EditingAction(title: "翻译", action: #selector(ReaderHost.translateSelection)), EditingAction(title: "保存到页边", action: #selector(ReaderHost.saveExcerpt))]
            let view: UIViewController & Navigator
            if publication.conforms(to: .pdf) {
                let pdf = try MobilePDFNavigator(publication: publication, book: book, source: await store.repository.file(book, name: book.originalName), location: locator, continuous: scroll, preparation: store.preparation, delegate: self)
                pdf.onTap = { [weak self] in self?.contentTapped() }
                pdf.onJump = { [weak self] locator in self?.history.append(locator) }
                pdf.onCopy = { [weak self] in self?.copySelection() }
                pdf.onCopyImage = { [weak self] in self?.copySourceImage() }
                pdf.onSave = { [weak self] in self?.saveExcerpt() }
                pdf.onAsk = { [weak self] in self?.ask(translate: $0) }
                pdf.onLookup = { [weak self] in self?.lookupSelection() }
                view = pdf
            } else if publication.conforms(to: .epub) || publication.conforms(to: .divina) {
                let epub = try EPUBNavigatorViewController(publication: publication, initialLocation: locator, config: .init(preferences: preferences(), editingActions: actions))
                epub.delegate = self; view = epub
            } else { throw LibraryFailure.unsupported }
            navigator = view
            if let visual = view as? VisualNavigator {
                directionalNavigation = DirectionalNavigationAdapter(pointerPolicy: .init(types: []), animatedTransition: true)
                directionalNavigation?.bind(to: visual)
                visual.addObserver(.tap { [weak self] _ in
                    guard let self, (self.navigator as? SelectableNavigator)?.currentSelection == nil else { return false }
                    self.contentTapped()
                    return false
                })
            }
            controller = ReaderHost(navigator: view, reader: self)
            chapter = book.chapter
            progress = book.progress
            updateBookmarkState()
        } catch { failure = error.localizedDescription }
    }
    private func contentTapped() {
        guard !hasContentSelection else { return }
        let now = ProcessInfo.processInfo.systemUptime
        chromeTask?.cancel()
        if now - lastContentTap < 0.4 { lastContentTap = 0; return }
        lastContentTap = now
        chromeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let self, self.selection == nil, !self.hasContentSelection else { return }
            withAnimation(.easeOut(duration: 0.2)) { self.chromeVisible.toggle() }
        }
    }
    private var hasContentSelection: Bool { (navigator as? SelectableNavigator)?.currentSelection != nil || (navigator as? MobilePDFNavigator)?.hasSelection == true }
    private func preferences() -> EPUBPreferences {
        EPUBPreferences(columnCount: .one, fontFamily: fontFamily.isEmpty ? nil : FontFamily(rawValue: fontFamily), fontSize: fontScale / 100, lineHeight: lineHeight, pageMargins: pageMargins, publisherStyles: fontFamily.isEmpty && lineHeight == 1.85 && pageMargins == 1, scroll: scroll, theme: theme == "night" ? .dark : theme == "sepia" ? .sepia : .light)
    }
    func apply() {
        let appearance = ReadingAppearance(fontScale: fontScale, lineHeight: lineHeight, pageMargins: pageMargins, fontFamily: fontFamily, theme: theme, scroll: scroll)
        Task {
            do { try await store.repository.saveAppearance(book.id, value: appearance); await store.refresh() }
            catch { failure = error.localizedDescription }
        }
        (navigator as? EPUBNavigatorViewController)?.submitPreferences(preferences())
        (navigator as? MobilePDFNavigator)?.applyScroll(scroll)
    }
    func navigator(_ navigator: Navigator, locationDidChange locator: Locator) {
        chapter = locator.title ?? book.title
        progress = locator.locations.totalProgression ?? locator.locations.progression ?? 0
        updateBookmarkState(locator)
        saveTask?.cancel()
        saveTask = Task { try? await Task.sleep(for: .milliseconds(350)); guard !Task.isCancelled else { return }; await flush() }
    }
    func navigator(_ navigator: Navigator, presentError error: NavigatorError) { failure = error.localizedDescription }
    func navigator(_ navigator: SelectableNavigator, shouldShowMenuForSelection selection: Selection) -> Bool {
        chromeTask?.cancel()
        selectionMenuTask?.cancel()
        selectionMenuTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled, let self, self.hasContentSelection else { return }
            if let source = try? await self.selectedSource(translate: false), !Task.isCancelled { self.lastSelection = source }
            if !Task.isCancelled { (self.controller as? ReaderHost)?.showSelectionMenu() }
        }
        return false
    }
    func navigator(_ navigator: EPUBNavigatorViewController, setupUserScripts userContentController: WKUserContentController) {
        if let url = Bundle.main.url(forResource: "selection", withExtension: "js", subdirectory: "Web"), let script = try? String(contentsOf: url, encoding: .utf8) {
            userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        }
    }
    func go(_ link: ReadiumShared.Link) async {
        if let current = navigator?.currentLocation { history.append(current) }
        if await navigator?.go(to: link) != true { _ = history.popLast(); failure = "暂时无法前往该章节。" }
    }
    func back() async { if let previous = history.popLast() { _ = await navigator?.go(to: previous) } }
    func goSource(_ raw: String) async {
        do {
            let destination = try Locator(jsonString: raw)
            if let current = navigator?.currentLocation { history.append(current) }
            if await navigator?.go(to: destination) != true { _ = history.popLast(); failure = "原文暂时无法定位。" }
        } catch { failure = error.localizedDescription }
    }
    func bookmark() async {
        guard let locator = navigator?.currentLocation, let raw = try? locator.jsonString() else { return }
        do { try await store.repository.toggleBookmark(book.id, title: chapter.isEmpty ? book.title : chapter, locator: raw); await store.refresh(); updateBookmarkState() }
        catch { failure = error.localizedDescription }
    }
    private func updateBookmarkState(_ location: Locator? = nil) {
        guard let locator = location ?? navigator?.currentLocation, let raw = try? locator.jsonString() else { bookmarked = false; return }
        bookmarked = store.books.first(where: { $0.id == book.id })?.bookmarks.contains(where: { $0.locator == raw }) == true
    }
    func flush() async {
        guard let locator = navigator?.currentLocation, let raw = try? locator.jsonString() else { return }
        do { try await store.repository.saveLocation(book.id, locator: raw, progress: progress, chapter: chapter); await store.refresh() }
        catch { failure = error.localizedDescription }
    }
    private func selectedSource(translate: Bool) async throws -> AssistantSelection {
        if let pdf = navigator as? MobilePDFNavigator { return try await pdf.selectedSource(translate: translate) }
        guard let selected = (navigator as? SelectableNavigator)?.currentSelection else { throw ServiceError.message("请先长按选择一段文字。") }
        let locator = try selected.locator.jsonString()
        var quote = selected.locator.text.highlight ?? ""
        if let epub = navigator as? EPUBNavigatorViewController,
           case .success(let value) = await epub.evaluateJavaScript("window.pageBetweenSelectedSource?.()"), let source = value as? String, !source.isEmpty { quote = source }
        guard !quote.isEmpty else { throw ServiceError.message("请先长按选择一段文字。") }
        return AssistantSelection(book: book.id, quote: quote, locator: locator, translate: translate)
    }
    func ask(translate: Bool) {
        Task {
            do {
                let source = try await selectedSource(translate: translate)
                guard source.quote.count <= 12000 else { throw ServiceError.message("选段过长，请缩小范围。") }
                selection = source; lastSelection = source
            } catch { failure = error.localizedDescription }
        }
    }
    func saveExcerpt() {
        Task {
            do {
                let source = try await selectedSource(translate: false)
                guard await publication?.rights.copy(text: source.quote) == true else { throw ServiceError.message("本书不允许保存此选段。") }
                let excerpt = SavedExcerpt(quote: source.quote, markdown: source.markdown, locator: source.locator, chapter: chapter, objects: source.objects, rects: source.rects)
                try await store.repository.saveExcerpt(book.id, excerpt: excerpt)
                lastSelection = source
                notice = "已保存到页边"
                Task { try? await Task.sleep(for: .seconds(2)); notice = nil }
                await store.refresh()
            } catch { failure = error.localizedDescription }
        }
    }
    func lookupSelection() {
        Task {
            do {
                let source = try await selectedSource(translate: false)
                let term = source.quote.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !term.isEmpty, term.count <= 100 else { throw ServiceError.message("请选择一个词或短语。") }
                controller?.present(UIReferenceLibraryViewController(term: term), animated: true)
            } catch { failure = error.localizedDescription }
        }
    }
    func copySelection() {
        Task {
            do {
                let source = try await selectedSource(translate: false)
                guard await publication?.rights.copy(text: source.quote) == true else { throw ServiceError.message("本书不允许复制此选段。") }
                UIPasteboard.general.string = source.quote
                lastSelection = source
            } catch { failure = error.localizedDescription }
        }
    }
    func copySourceImage() {
        Task {
            do {
                let source = try await selectedSource(translate: false)
                guard let object = source.objects.first, await publication?.rights.copy(text: source.quote) == true else { throw ServiceError.message("本书不允许复制此选段。") }
                let original = try await store.repository.file(book, name: book.originalName)
                let data = try await Task.detached { try PDFSourceContent.image(object, original: original) }.value
                UIPasteboard.general.setData(data, forPasteboardType: "public.png"); lastSelection = source
            } catch { failure = error.localizedDescription }
        }
    }
}

@MainActor final class ReaderHost: UIViewController, @preconcurrency UIEditMenuInteractionDelegate {
    let navigator: UIViewController & Navigator
    weak var reader: MobileReader?
    private lazy var selectionMenu = UIEditMenuInteraction(delegate: self)
    init(navigator: UIViewController & Navigator, reader: MobileReader) { self.navigator = navigator; self.reader = reader; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Storyboard is not used") }
    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(navigator); navigator.view.frame = view.bounds; navigator.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(navigator.view); navigator.didMove(toParent: self)
        view.addInteraction(selectionMenu)
    }
    private var selectionFrame: CGRect? {
        guard let frame = (navigator as? SelectableNavigator)?.currentSelection?.frame else { return nil }
        let visible = view.convert(frame, from: navigator.view).intersection(view.bounds)
        return visible.isNull || visible.isEmpty ? nil : visible
    }
    func showSelectionMenu() {
        guard let target = selectionFrame, view.window != nil else { return }
        selectionMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: CGPoint(x: target.midX, y: target.midY)))
    }
    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard (navigator as? SelectableNavigator)?.currentSelection != nil else { return nil }
        var actions: [UIMenuElement] = [
            UIAction(title: "复制", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in self?.reader?.copySelection() },
            UIAction(title: "提问", image: UIImage(systemName: "text.bubble")) { [weak self] _ in self?.reader?.ask(translate: false) },
            UIAction(title: "翻译", image: UIImage(systemName: "character.bubble")) { [weak self] _ in self?.reader?.ask(translate: true) },
            UIAction(title: "保存到页边", image: UIImage(systemName: "text.badge.plus")) { [weak self] _ in self?.reader?.saveExcerpt() }
        ]
        if let text = (navigator as? SelectableNavigator)?.currentSelection?.locator.text.highlight, text.count <= 100 {
            actions.append(UIAction(title: "查询", image: UIImage(systemName: "book.closed")) { [weak self] _ in self?.present(UIReferenceLibraryViewController(term: text), animated: true) })
        }
        if reader?.publication?.isProtected == false {
            actions.append(UIAction(title: "共享", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
                guard let self, let text = (self.navigator as? SelectableNavigator)?.currentSelection?.locator.text.highlight else { return }
                let activity = UIActivityViewController(activityItems: [text], applicationActivities: nil)
                activity.popoverPresentationController?.sourceView = self.view
                activity.popoverPresentationController?.sourceRect = self.editMenuInteraction(interaction, targetRectFor: configuration)
                self.present(activity, animated: true)
            })
        }
        return UIMenu(children: actions)
    }
    func editMenuInteraction(_ interaction: UIEditMenuInteraction, targetRectFor configuration: UIEditMenuConfiguration) -> CGRect {
        selectionFrame ?? .zero
    }
    @objc func askSelection() { reader?.ask(translate: false) }
    @objc func translateSelection() { reader?.ask(translate: true) }
    @objc func saveExcerpt() { reader?.saveExcerpt() }
    @objc func copySelection() { reader?.copySelection() }
}

struct NavigatorHost: UIViewControllerRepresentable {
    let controller: UIViewController
    func makeUIViewController(context: Context) -> UIViewController { controller }
    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}

struct ReaderScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @StateObject private var reader: MobileReader
    @State private var toc = false
    @State private var appearance = false
    @State private var bookmarkTab = false
    @State private var chapterQuery = ""
    @State private var excerpts = false
    @State private var conversations = false
    @State private var processing = false
    init(book: MobileBook, store: LibraryStore) { _reader = StateObject(wrappedValue: MobileReader(book: book, store: store)) }
    var body: some View {
        NavigationStack {
            Group {
                if let controller = reader.controller { NavigatorHost(controller: controller) }
                else if let failure = reader.failure { ContentUnavailableView("暂时无法打开", systemImage: "book.closed", description: Text(failure)) }
                else { ProgressView("正在打开书籍…") }
            }
            .overlay(alignment: .bottom) { if let notice = reader.notice { Text(notice).font(.callout).padding(12).background(.regularMaterial, in: Capsule()).padding(.bottom, 64).accessibilityAddTraits(.updatesFrequently) } }
            .navigationTitle(reader.book.title).navigationBarTitleDisplayMode(.inline)
            .toolbar(reader.chromeVisible || reader.controller == nil || reader.failure != nil ? .visible : .hidden, for: .navigationBar, .bottomBar)
            .statusBarHidden(!reader.chromeVisible && reader.controller != nil && reader.failure == nil)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("书库", systemImage: "chevron.left") { Task { await reader.flush(); dismiss() } } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !reader.history.isEmpty { Button("返回原位置", systemImage: "arrow.uturn.backward") { Task { await reader.back() } } }
                    Button("目录", systemImage: "list.bullet") { toc = true }
                    Menu {
                        Section("阅读记录") {
                            Button("页边", systemImage: "text.badge.plus") { excerpts = true }
                            Button("书签", systemImage: "bookmark") { bookmarkTab = true; toc = true }
                            Button("答疑记录", systemImage: "text.bubble") { conversations = true }
                        }
                        if reader.book.format == "pdf" { Button("文档处理", systemImage: "doc.badge.gearshape") { processing = true } }
                        if let recent = reader.lastSelection {
                            Button("提问最近选段", systemImage: "text.bubble") { reader.selection = AssistantSelection(book: recent.book, quote: recent.quote, locator: recent.locator, translate: false, markdown: recent.markdown, objects: recent.objects, rects: recent.rects) }
                            if !recent.quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Button("翻译最近选段", systemImage: "character.bubble") { reader.selection = AssistantSelection(book: recent.book, quote: recent.quote, locator: recent.locator, translate: true, markdown: recent.markdown, objects: recent.objects, rects: recent.rects) } }
                        }
                    } label: { Image(systemName: "ellipsis") }.accessibilityIdentifier("reader.more")
                }
                ToolbarItem(placement: .bottomBar) {
                    HStack(spacing: 8) {
                        Button { Task { _ = await reader.navigator?.goBackward(options: .animated) } } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("上一页")
                        VStack(spacing: 3) { Text(reader.chapter).lineLimit(1).font(.caption); Text("\(Int(reader.progress * 100))%").font(.caption2.monospacedDigit()).foregroundStyle(.secondary) }.frame(maxWidth: .infinity).accessibilityElement(children: .combine).accessibilityIdentifier("reader.position")
                        Button { Task { await reader.bookmark() } } label: { Image(systemName: reader.bookmarked ? "bookmark.fill" : "bookmark").frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityIdentifier("reader.bookmark").accessibilityLabel(reader.bookmarked ? "移除书签" : "添加书签")
                        Button { appearance = true } label: { Image(systemName: "textformat.size").frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityIdentifier("reader.appearance").accessibilityLabel("阅读设置")
                        Button { Task { _ = await reader.navigator?.goForward(options: .animated) } } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("下一页")
                    }.buttonStyle(.plain).frame(maxWidth: .infinity)
                }
            }
            .sheet(isPresented: $toc) { navigationSheet }
            .sheet(isPresented: $appearance) { appearanceSheet }
            .sheet(item: $reader.selection) { selection in AssistantScreen(selection: selection, title: reader.book.title, repository: reader.store.repository, openSource: { raw in Task { await reader.goSource(raw) } }) }
            .sheet(isPresented: $conversations) { ConversationHistoryScreen(book: reader.book, repository: reader.store.repository, openSource: { raw in conversations = false; Task { await reader.goSource(raw) } }) }
            .sheet(isPresented: $excerpts) { ExcerptsScreen(book: reader.book, repository: reader.store.repository, openSource: { raw in excerpts = false; Task { await reader.goSource(raw) } }) }
            .sheet(isPresented: $processing) { DocumentPreparationScreen(book: reader.book, store: reader.store) }
            .task { await reader.load() }
            .onChange(of: phase) { if phase != .active { reader.store.preparation.pauseAll(); Task { await reader.flush() } } }
            .alert("操作未完成", isPresented: Binding(get: { reader.failure != nil && reader.controller != nil }, set: { if !$0 { reader.failure = nil } })) { Button("好") { reader.failure = nil } } message: { Text(reader.failure ?? "") }
        }.tint(MobilePalette.accent).preferredColorScheme(reader.theme == "night" ? .dark : .light)
    }
    private func appearanceSlider(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double, display: String) -> some View {
        HStack(spacing: 12) {
            Text(title).frame(width: 52, alignment: .leading)
            Slider(value: value, in: range, step: step).accessibilityLabel(title).onChange(of: value.wrappedValue) { reader.apply() }
            Text(display).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 44, alignment: .trailing)
        }
    }
    private var appearanceSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("浏览方式", selection: $reader.scroll) { Text("左右翻页").tag(false); Text("连续滚动").tag(true) }.pickerStyle(.segmented).onChange(of: reader.scroll) { reader.apply() }
                }
                if reader.book.format != "pdf" {
                    Section {
                        HStack {
                            ForEach(["沉浸", "舒展", "紧凑"], id: \.self) { title in
                                let size = title == "沉浸" ? 95.0 : title == "舒展" ? 100.0 : 90.0
                                let line = title == "沉浸" ? 1.8 : title == "舒展" ? 1.95 : 1.7
                                Button(title) { reader.fontScale = size; reader.lineHeight = line; reader.pageMargins = 1; reader.apply() }
                                    .buttonStyle(.bordered).tint(reader.fontScale == size && reader.lineHeight == line ? MobilePalette.accent : .secondary)
                                    .accessibilityAddTraits(reader.fontScale == size && reader.lineHeight == line ? .isSelected : [])
                            }
                        }
                        appearanceSlider("字号", value: $reader.fontScale, range: 70...200, step: 10, display: "\(Int(reader.fontScale))%")
                        Picker("字体", selection: $reader.fontFamily) { Text("原书").tag(""); Text("宋体").tag("Songti SC"); Text("苹方").tag("PingFang SC"); Text("Georgia").tag("Georgia") }.onChange(of: reader.fontFamily) { reader.apply() }
                        appearanceSlider("行距", value: $reader.lineHeight, range: 1.4...2.2, step: 0.05, display: String(format: "%.2f", reader.lineHeight))
                        appearanceSlider("页边距", value: $reader.pageMargins, range: 0.5...2, step: 0.1, display: String(format: "%.1f", reader.pageMargins))
                    }
                    Section {
                        Picker("纸张", selection: $reader.theme) { Text("纸白").tag("paper"); Text("暖纸").tag("sepia"); Text("夜间").tag("night") }.pickerStyle(.segmented).onChange(of: reader.theme) { reader.apply() }
                    }
                }
            }
            .navigationTitle("阅读设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { appearance = false } }
        }.presentationDetents([.height(440), .large]).presentationDragIndicator(.visible)
    }
    private var navigationSheet: some View {
        NavigationStack {
            List {
                Picker("导航", selection: $bookmarkTab) {
                    Text("目录").tag(false)
                    Text("书签").tag(true)
                }.pickerStyle(.segmented)
                if bookmarkTab { bookmarkRows }
                else { chapterRows }
            }
            .searchable(text: $chapterQuery, prompt: "查找章节")
            .navigationTitle(reader.book.title).navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { toc = false } }
        }
    }
    private var bookmarkRows: some View {
        let marks: [ReadingBookmark] = reader.store.books.first(where: { $0.id == reader.book.id })?.bookmarks ?? []
        return ForEach(marks.filter { chapterQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(chapterQuery) }) { mark in
            Button(action: { openBookmark(mark) }) { Text(mark.title) }
        }
    }
    private var chapterRows: some View {
        let entries = flatten(reader.contents).filter { chapterQuery.isEmpty || ($0.link.title ?? "").localizedCaseInsensitiveContains(chapterQuery) }
        return ForEach(entries.indices, id: \.self) { index in
            let item = entries[index]
            Button {
                Task { await reader.go(item.link); toc = false }
            } label: {
                Text(item.link.title ?? "章节").padding(.leading, CGFloat(item.depth * 16)).foregroundStyle(reader.chapter == item.link.title ? MobilePalette.accent : Color.primary).fontWeight(reader.chapter == item.link.title ? .semibold : .regular)
            }
        }
    }
    private func openBookmark(_ mark: ReadingBookmark) {
        Task { @MainActor in
            do {
                let locator = try Locator(jsonString: mark.locator)
                guard let navigator = reader.navigator else { return }
                if let current = navigator.currentLocation { reader.history.append(current) }
                if await navigator.go(to: locator, options: .none) != true { _ = reader.history.popLast(); reader.failure = "书签暂时无法定位。" }
                toc = false
            } catch { reader.failure = error.localizedDescription }
        }
    }
    private func flatten(_ links: [ReadiumShared.Link], depth: Int = 0) -> [(link: ReadiumShared.Link, depth: Int)] { links.flatMap { [(link: $0, depth: depth)] + flatten($0.children, depth: depth+1) } }
}
