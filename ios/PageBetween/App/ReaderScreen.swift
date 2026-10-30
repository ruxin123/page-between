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
}

@MainActor final class MobileReader: NSObject, ObservableObject, EPUBNavigatorDelegate, PDFNavigatorDelegate {
    @Published var controller: UIViewController?
    @Published var publication: Publication?
    @Published var contents: [ReadiumShared.Link] = []
    @Published var chapter = ""
    @Published var progress = 0.0
    @Published var failure: String?
    @Published var selection: AssistantSelection?
    @Published var lastSelection: AssistantSelection?
    @Published var fontScale = 100.0
    @Published var fontFamily = ""
    @Published var scroll = false
    @Published var theme = "paper"
    @Published var history: [Locator] = []
    @Published var chromeVisible = true
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
        fontFamily = defaults.string(forKey: "reading.fontFamily") ?? ""
        theme = defaults.string(forKey: "reading.theme") ?? "paper"
        let key = book.format == "pdf" ? "reading.pdfScroll" : "reading.textScroll"
        scroll = defaults.object(forKey: key) == nil ? book.format == "pdf" : defaults.bool(forKey: key)
    }
    func load() async {
        guard !loaded else { return }; loaded = true
        do {
            let publication = try await store.open(book)
            self.publication = publication
            contents = (try? await publication.tableOfContents().get()) ?? []
            let locator = try book.locator.flatMap { try Locator(jsonString: $0) }
            let actions = [EditingAction.lookup, .share, EditingAction(title: "复制", action: #selector(ReaderHost.copySelection)), EditingAction(title: "提问", action: #selector(ReaderHost.askSelection)), EditingAction(title: "翻译", action: #selector(ReaderHost.translateSelection))]
            let view: UIViewController & Navigator
            if publication.conforms(to: .pdf) {
                let pdf = try MobilePDFNavigator(publication: publication, book: book, source: await store.repository.file(book, name: book.originalName), location: locator, continuous: scroll, preparation: store.preparation, delegate: self)
                pdf.onTap = { [weak self] in self?.contentTapped() }
                pdf.onJump = { [weak self] locator in self?.history.append(locator) }
                pdf.onCopy = { [weak self] in self?.copySelection() }
                pdf.onCopyImage = { [weak self] in self?.copySourceImage() }
                pdf.onAsk = { [weak self] in self?.ask(translate: $0) }
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
        EPUBPreferences(columnCount: .one, fontFamily: fontFamily.isEmpty ? nil : FontFamily(rawValue: fontFamily), fontSize: fontScale / 100, lineHeight: 1.85, pageMargins: 1.0, publisherStyles: fontFamily.isEmpty, scroll: scroll, theme: theme == "night" ? .dark : theme == "sepia" ? .sepia : .light)
    }
    func apply() {
        let defaults = UserDefaults.standard
        defaults.set(fontScale, forKey: "reading.fontScale"); defaults.set(fontFamily, forKey: "reading.fontFamily"); defaults.set(theme, forKey: "reading.theme"); defaults.set(scroll, forKey: book.format == "pdf" ? "reading.pdfScroll" : "reading.textScroll")
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
            UIAction(title: "翻译", image: UIImage(systemName: "character.bubble")) { [weak self] _ in self?.reader?.ask(translate: true) }
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
            .navigationTitle(reader.book.title).navigationBarTitleDisplayMode(.inline)
            .toolbar(reader.chromeVisible ? .visible : .hidden, for: .navigationBar, .bottomBar)
            .statusBarHidden(!reader.chromeVisible)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("书库", systemImage: "chevron.left") { Task { await reader.flush(); dismiss() } } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !reader.history.isEmpty { Button("返回原位置", systemImage: "arrow.uturn.backward") { Task { await reader.back() } } }
                    Button("目录", systemImage: "list.bullet") { toc = true }
                    Menu {
                        Button("阅读设置", systemImage: "textformat.size") { appearance = true }
                        Button("答疑记录", systemImage: "text.bubble") { conversations = true }
                        if reader.book.format == "pdf" { Button("文档处理", systemImage: "doc.badge.gearshape") { processing = true } }
                        if let recent = reader.lastSelection {
                            Button("提问最近选段", systemImage: "text.bubble") { reader.selection = AssistantSelection(book: recent.book, quote: recent.quote, locator: recent.locator, translate: false, markdown: recent.markdown, objects: recent.objects) }
                            if !recent.quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Button("翻译最近选段", systemImage: "character.bubble") { reader.selection = AssistantSelection(book: recent.book, quote: recent.quote, locator: recent.locator, translate: true, markdown: recent.markdown, objects: recent.objects) } }
                        }
                    } label: { Image(systemName: "ellipsis") }.accessibilityIdentifier("reader.more")
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("上一页", systemImage: "chevron.left") { Task { _ = await reader.navigator?.goBackward(options: .animated) } }
                    Spacer()
                    VStack(spacing: 3) { Text(reader.chapter).lineLimit(1).font(.caption); Text("\(Int(reader.progress * 100))%").font(.caption2.monospacedDigit()).foregroundStyle(.secondary) }.frame(width: 112)
                    Spacer()
                    Button("书签", systemImage: reader.bookmarked ? "bookmark.fill" : "bookmark") { Task { await reader.bookmark() } }.accessibilityIdentifier("reader.bookmark").accessibilityLabel(reader.bookmarked ? "移除书签" : "添加书签")
                    Button("下一页", systemImage: "chevron.right") { Task { _ = await reader.navigator?.goForward(options: .animated) } }
                }
            }
            .sheet(isPresented: $toc) { navigationSheet }
            .sheet(isPresented: $appearance) { NavigationStack { Form {
                Toggle("连续滚动", isOn: $reader.scroll).onChange(of: reader.scroll) { reader.apply() }
                if reader.book.format != "pdf" {
                    Picker("字体", selection: $reader.fontFamily) { Text("原书").tag(""); Text("宋体").tag("Songti SC"); Text("苹方").tag("PingFang SC"); Text("Georgia").tag("Georgia") }.onChange(of: reader.fontFamily) { reader.apply() }
                    LabeledContent("字号", value: "\(Int(reader.fontScale))%")
                    Slider(value: $reader.fontScale, in: 70...200, step: 10).onChange(of: reader.fontScale) { reader.apply() }
                    Picker("纸张", selection: $reader.theme) { Text("纸白").tag("paper"); Text("暖纸").tag("sepia"); Text("夜间").tag("night") }.onChange(of: reader.theme) { reader.apply() }
                }
            }.navigationTitle("阅读设置").navigationBarTitleDisplayMode(.inline).toolbar { Button("完成") { appearance = false } } }.presentationDetents([.medium]) }
            .sheet(item: $reader.selection) { selection in AssistantScreen(selection: selection, title: reader.book.title, repository: reader.store.repository, openSource: { raw in Task { await reader.goSource(raw) } }) }
            .sheet(isPresented: $conversations) { ConversationHistoryScreen(book: reader.book, repository: reader.store.repository, openSource: { raw in conversations = false; Task { await reader.goSource(raw) } }) }
            .sheet(isPresented: $processing) { DocumentPreparationScreen(book: reader.book, store: reader.store) }
            .task { await reader.load() }
            .onChange(of: phase) { if phase != .active { reader.store.preparation.pauseAll(); Task { await reader.flush() } } }
            .alert("操作未完成", isPresented: Binding(get: { reader.failure != nil && reader.controller != nil }, set: { if !$0 { reader.failure = nil } })) { Button("好") { reader.failure = nil } } message: { Text(reader.failure ?? "") }
        }.tint(MobilePalette.accent).preferredColorScheme(reader.theme == "night" ? .dark : .light)
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
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { toc = false } }
        }
    }
    private var bookmarkRows: some View {
        let marks: [ReadingBookmark] = reader.store.books.first(where: { $0.id == reader.book.id })?.bookmarks ?? []
        return ForEach(marks) { mark in
            Button(action: { openBookmark(mark) }) { Text(mark.title) }
        }
    }
    private var chapterRows: some View {
        let entries = flatten(reader.contents)
        return ForEach(entries.indices, id: \.self) { index in
            let item = entries[index]
            Button {
                Task { await reader.go(item.link); toc = false }
            } label: {
                Text(item.link.title ?? "章节").padding(.leading, CGFloat(item.depth * 16)).foregroundStyle(.primary)
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
