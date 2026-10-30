import UIKit
import PDFKit
import ReadiumShared
import ReadiumNavigator
import Combine

private final class ReadingPDFView: PDFView {
    var copySource: (() -> Void)?
    var askSource: (() -> Void)?
    var translateSource: (() -> Void)?
    var resolveDestination: ((PDFDestination) -> PDFDestination)?
    override func copy(_ sender: Any?) { copySource?() }
    override func go(to destination: PDFDestination) { super.go(to: resolveDestination?(destination) ?? destination) }
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        let actions = [UIAction(title: "提问") { [weak self] _ in self?.askSource?() }, UIAction(title: "翻译") { [weak self] _ in self?.translateSource?() }]
        builder.insertChild(UIMenu(options: .displayInline, children: actions), atStartOfMenu: .standardEdit)
    }
}

@MainActor final class MobilePDFNavigator: UIViewController, @preconcurrency Navigator, PDFViewDelegate, UIGestureRecognizerDelegate, @preconcurrency UIEditMenuInteractionDelegate {
    let publication: Publication
    let book: MobileBook
    let preparation: PDFPreparationStore
    weak var delegate: NavigatorDelegate?
    var onTap: (() -> Void)?
    var onJump: ((Locator) -> Void)?
    var onCopy: (() -> Void)?
    var onCopyImage: (() -> Void)?
    var onAsk: ((Bool) -> Void)?
    private let pdf = ReadingPDFView()
    private let document: PDFKit.PDFDocument
    private let initial: Locator?
    private var continuous: Bool
    private var replacing = false
    private var programmatic = false
    private var originals: [Int: PDFPage] = [:]
    private var preparedDocuments: [Int: PDFKit.PDFDocument] = [:]
    private var preparedRevisions: [Int: UUID] = [:]
    private var refreshTask: Task<Void, Never>?
    private var revisions: AnyCancellable?
    private var observers: [NSObjectProtocol] = []
    private var headings: [(Int, String)] = []
    private var canonicalPages: [Int: PDFPreparedPage] = [:]
    private var selectedObject: (index: Int, object: PDFSourceObject, page: PDFPage, annotation: PDFAnnotation)?
    private lazy var objectMenu = UIEditMenuInteraction(delegate: self)

    init(publication: Publication, book: MobileBook, source: URL, location: Locator?, continuous: Bool, preparation: PDFPreparationStore, delegate: NavigatorDelegate) throws {
        guard let document = PDFKit.PDFDocument(url: source), document.pageCount > 0, document.pageCount <= 100000, !document.isLocked else { throw LibraryFailure.invalidFile }
        self.publication = publication; self.book = book; self.document = document; self.initial = location; self.continuous = continuous; self.preparation = preparation; self.delegate = delegate
        super.init(nibName: nil, bundle: nil)
        func visit(_ outline: PDFOutline, depth: Int = 0) {
            guard depth < 20, headings.count < 10000 else { return }
            if let page = outline.destination?.page, let title = outline.label { let index = document.index(for: page); if index != NSNotFound { headings.append((index, title)) } }
            for index in 0..<outline.numberOfChildren { if let child = outline.child(at: index) { visit(child, depth: depth + 1) } }
        }
        if let outline = document.outlineRoot { visit(outline) }
        headings.sort { $0.0 < $1.0 }
    }
    required init?(coder: NSCoder) { fatalError("Storyboard is not used") }
    override func viewDidLoad() {
        super.viewDidLoad()
        pdf.frame = view.bounds; pdf.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        pdf.document = document; pdf.delegate = self; view.addSubview(pdf)
        pdf.accessibilityIdentifier = "reader.pdf"
        pdf.addInteraction(objectMenu)
        pdf.backgroundColor = .secondarySystemBackground
        pdf.minScaleFactor = 0.25; pdf.maxScaleFactor = 4
        pdf.copySource = { [weak self] in self?.onCopy?() }
        pdf.askSource = { [weak self] in self?.onAsk?(false) }
        pdf.translateSource = { [weak self] in self?.onAsk?(true) }
        pdf.resolveDestination = { [weak self] in self?.destination($0) ?? $0 }
        applyScroll(continuous)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false; tap.delegate = self; pdf.addGestureRecognizer(tap)
        for name in [Notification.Name.PDFViewPageChanged, .PDFViewVisiblePagesChanged] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: pdf, queue: .main) { [weak self] _ in Task { @MainActor in self?.changed() } })
        }
        observers.append(NotificationCenter.default.addObserver(forName: .PDFViewSelectionChanged, object: pdf, queue: .main) { [weak self] _ in
            Task { @MainActor in if self?.pdf.currentSelection != nil { self?.clearObject() } }
        })
        revisions = preparation.$revision.dropFirst().sink { [weak self] _ in self?.refreshPreparedPages() }
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let initial, !didOpen { didOpen = true; Task { _ = await go(to: initial, options: .none); changed() } }
        else { didOpen = true; changed() }
    }
    private var didOpen = false
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) }; refreshTask?.cancel() }

    var currentLocation: Locator? { location(page: currentIndex) }
    var currentIndex: Int { pdf.currentPage.map { document.index(for: $0) }.flatMap { $0 == NSNotFound ? nil : $0 } ?? 0 }
    var pageCount: Int { document.pageCount }
    var zoomPercent: Double { Double(pdf.scaleFactor * 100) }
    private func location(page: Int, quote: String? = nil, y: Double? = nil) -> Locator? {
        var fragments = ["page=\(page + 1)"]
        if let y { fragments.append("y=\(y)") }
        var value: [String: Any] = ["href": "publication.pdf", "type": "application/pdf", "title": headings.last(where: { $0.0 <= page })?.1 ?? "第 \(page + 1) 页", "locations": ["position": page + 1, "fragments": fragments, "totalProgression": Double(page) / Double(max(1, pageCount - 1))]]
        if let quote { value["text"] = ["highlight": quote] }
        guard let data = try? JSONSerialization.data(withJSONObject: value), let raw = String(data: data, encoding: .utf8) else { return nil }
        return try? Locator(jsonString: raw)
    }
    func selectedSource(translate: Bool) async throws -> AssistantSelection {
        if let selectedObject {
            let object = selectedObject.object
            guard object.text.count <= 12000 else { throw ServiceRequestFailure.selectionTooLong }
            guard let locator = location(page: selectedObject.index, quote: object.text, y: object.box.top) else { throw LibraryFailure.invalidFile }
            return AssistantSelection(book: book.id, quote: object.text, locator: try locator.jsonString(), translate: translate, markdown: object.markdown, objects: [object])
        }
        guard let selection = pdf.currentSelection?.copy() as? PDFSelection, let native = selection.string, !native.isEmpty else { throw ServiceError.message("请先长按选择一段文字。") }
        guard native.count <= 12000 else { throw ServiceRequestFailure.selectionTooLong }
        let pages = selection.pages.map { (document.index(for: $0), $0) }.filter { $0.0 != NSNotFound }.sorted { $0.0 < $1.0 }
        guard let first = pages.first else { throw LibraryFailure.invalidFile }
        var pieces: [PDFSelectedSource] = []
        for (index, page) in pages {
            var data = canonicalPages[index]
            if data == nil { data = try? await preparation.repository.pdfPage(book.id, page: index + 1) }
            if let data, data.mineruCompleted, let glyphs = PDFSourceContent.glyphs(selection, page: page) {
                let result = await Task.detached { PDFSelectionAssembler.assemble(glyphs, blocks: data.blocks, page: index + 1) }.value
                pieces.append(result)
            } else {
                let raw = (0..<selection.numberOfTextRanges(on: page)).compactMap { page.selection(for: selection.range(at: $0, on: page))?.string }.joined(separator: "\n")
                pieces.append(PDFSelectedSource(raw: raw, markdown: raw))
            }
        }
        let raw = pieces.map(\.raw).joined(separator: "\n\n"), markdown = pieces.map(\.markdown).joined(separator: "\n\n")
        guard raw.count <= 12000, pieces.reduce(0, { $0 + $1.objects.count }) <= 32 else { throw ServiceRequestFailure.selectionTooLong }
        let box = PDFSourceContent.box(first.1, rectangle: selection.bounds(for: first.1))
        guard let locator = location(page: first.0, quote: raw, y: box?.top) else { throw LibraryFailure.invalidFile }
        return AssistantSelection(book: book.id, quote: raw, locator: try locator.jsonString(), translate: translate, markdown: markdown, objects: pieces.flatMap(\.objects))
    }
    var hasSelection: Bool { selectedObject != nil || !(pdf.currentSelection?.string ?? "").isEmpty }
    func applyScroll(_ continuous: Bool) {
        self.continuous = continuous
        let page = pdf.currentPage
        pdf.usePageViewController(!continuous)
        pdf.displayDirection = continuous ? .vertical : .horizontal
        pdf.displayMode = continuous ? .singlePageContinuous : .singlePage
        pdf.autoScales = true
        if let page { pdf.go(to: page) }
    }
    func zoom(_ percent: Double) { pdf.autoScales = false; pdf.scaleFactor = min(4, max(0.25, CGFloat(percent / 100))) }
    func fitWidth() {
        guard let page = pdf.currentPage else { return }
        pdf.autoScales = false
        let bounds = page.bounds(for: .cropBox)
        let width = page.rotation % 180 == 0 ? bounds.width : bounds.height
        pdf.scaleFactor = min(4, max(0.25, (pdf.bounds.width - 16) / width))
    }
    func fitPage() { pdf.autoScales = true }
    func go(to locator: Locator, options: NavigatorGoOptions) async -> Bool {
        let index = (locator.locations.position ?? locator.locations.fragments.compactMap(Self.pageNumber).first ?? 1) - 1
        let y = locator.locations.fragments.first(where: { $0.hasPrefix("y=") }).flatMap { Double($0.dropFirst(2)) }
        return navigate(index, y: y)
    }
    func go(to link: ReadiumShared.Link, options: NavigatorGoOptions) async -> Bool { navigate((Self.pageNumber(link.href) ?? 1) - 1) }
    func goForward(options: NavigatorGoOptions) async -> Bool { navigate(currentIndex + 1) }
    func goBackward(options: NavigatorGoOptions) async -> Bool { navigate(currentIndex - 1) }
    private static func pageNumber(_ value: String) -> Int? {
        value.components(separatedBy: CharacterSet(charactersIn: "#&")).first(where: { $0.hasPrefix("page=") }).flatMap { Int($0.dropFirst(5)) }
    }
    @discardableResult private func navigate(_ index: Int, y: Double? = nil) -> Bool {
        guard index >= 0, index < pageCount, let page = document.page(at: index) else { return false }
        programmatic = true; defer { programmatic = false }
        if let y, y.isFinite { let bounds = page.bounds(for: .cropBox); pdf.go(to: PDFDestination(page: page, at: CGPoint(x: bounds.minX, y: bounds.maxY - min(1, max(0, y)) * bounds.height))) }
        else { pdf.go(to: page) }
        changed(); return true
    }
    private func destination(_ target: PDFDestination) -> PDFDestination {
        if !programmatic, !replacing, let currentLocation { onJump?(currentLocation) }
        if let original = target.page, let index = originals.first(where: { $0.value === original })?.key, let replacement = document.page(at: index) {
            let transform = original.pageRef?.getDrawingTransform(.cropBox, rect: replacement.bounds(for: .mediaBox), rotate: 0, preserveAspectRatio: true) ?? .identity
            return PDFDestination(page: replacement, at: target.point.applying(transform))
        }
        return target
    }
    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: pdf)
        if let page = pdf.page(for: point, nearest: false) {
            let index = document.index(for: page), local = pdf.convert(point, to: page)
            let pixel = CGRect(x: local.x - 0.5, y: local.y - 0.5, width: 1, height: 1)
            if let box = PDFSourceContent.box(page, rectangle: pixel), let prepared = canonicalPages[index] {
                let x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2
                let candidates = prepared.blocks.compactMap { PDFSelectionAssembler.object($0, page: index + 1) }.filter { $0.box.left <= x && x <= $0.box.right && $0.box.top <= y && y <= $0.box.bottom }
                if let object = candidates.min(by: { ($0.box.right - $0.box.left) * ($0.box.bottom - $0.box.top) < ($1.box.right - $1.box.left) * ($1.box.bottom - $1.box.top) }), let rectangle = PDFSourceContent.rectangle(object.box, on: page) {
                    clearObject(); pdf.clearSelection()
                    let annotation = PDFAnnotation(bounds: rectangle, forType: .square, withProperties: nil)
                    annotation.color = UIColor(red: 0.29, green: 0.45, blue: 0.37, alpha: 1)
                    annotation.border = PDFBorder(); annotation.border?.lineWidth = 1.5
                    page.addAnnotation(annotation); selectedObject = (index, object, page, annotation)
                    objectMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
                    return
                }
            }
        }
        if selectedObject != nil { clearObject(); objectMenu.dismissMenu(); return }
        if !hasSelection { onTap?() }
    }
    private func clearObject() { if let selectedObject { selectedObject.page.removeAnnotation(selectedObject.annotation) }; selectedObject = nil }
    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard let selectedObject else { return nil }
        var actions: [UIMenuElement] = []
        if !selectedObject.object.text.isEmpty { actions.append(UIAction(title: selectedObject.object.type == "equation" ? "复制 LaTeX" : "复制", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in self?.onCopy?() }) }
        actions.append(UIAction(title: "复制原图", image: UIImage(systemName: "photo")) { [weak self] _ in self?.onCopyImage?() })
        actions.append(UIAction(title: "提问", image: UIImage(systemName: "text.bubble")) { [weak self] _ in self?.onAsk?(false) })
        if selectedObject.object.type != "equation", !selectedObject.object.text.isEmpty { actions.append(UIAction(title: "翻译", image: UIImage(systemName: "character.bubble")) { [weak self] _ in self?.onAsk?(true) }) }
        return UIMenu(children: actions)
    }
    func editMenuInteraction(_ interaction: UIEditMenuInteraction, targetRectFor configuration: UIEditMenuConfiguration) -> CGRect {
        guard let selectedObject, let rectangle = PDFSourceContent.rectangle(selectedObject.object.box, on: selectedObject.page) else { return .zero }
        return pdf.convert(rectangle, from: selectedObject.page)
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
    private func changed() {
        guard !replacing, let currentLocation else { return }
        if let selectedObject, selectedObject.index != currentIndex { clearObject(); objectMenu.dismissMenu() }
        delegate?.navigator(self, locationDidChange: currentLocation)
        preparation.prepareNearby(book, page: currentIndex + 1, total: pageCount)
        refreshPreparedPages()
    }
    func refreshPreparedPages() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self, !self.hasSelection else { return }
            let center = self.currentIndex
            for index in max(0, center - 1)...min(self.pageCount - 1, center + 2) {
                guard !Task.isCancelled else { return }
                guard let data = try? await self.preparation.repository.pdfPage(self.book.id, page: index + 1) else { continue }
                self.canonicalPages[index] = data
                guard data.ocrCompleted, !data.hasNativeText, !data.words.isEmpty,
                      self.preparedDocuments[index] == nil || self.preparedRevisions[index] != data.ocrRevision,
                      let file = try? await self.preparation.repository.file(self.book, name: "selection/page-\(index + 1).pdf"), let replacement = PDFKit.PDFDocument(url: file), let page = replacement.page(at: 0), let original = self.originals[index] ?? self.document.page(at: index) else { continue }
                guard !Task.isCancelled, !self.hasSelection else { return }
                self.replacing = true
                let destination = self.pdf.currentDestination, current = self.currentIndex
                let wasPrepared = self.preparedDocuments[index] != nil
                let transform = original.pageRef?.getDrawingTransform(.cropBox, rect: page.bounds(for: .mediaBox), rotate: 0, preserveAspectRatio: true) ?? .identity
                for annotation in original.annotations {
                    if let copy = annotation.copy() as? PDFAnnotation { copy.bounds = annotation.bounds.applying(transform); page.addAnnotation(copy) }
                }
                self.originals[index] = original; self.preparedDocuments[index] = replacement; self.preparedRevisions[index] = data.ocrRevision
                self.document.removePage(at: index); self.document.insert(page, at: index)
                if let visible = self.document.page(at: current) {
                    let point = destination?.point ?? CGPoint(x: 0, y: visible.bounds(for: .cropBox).maxY)
                    self.pdf.go(to: PDFDestination(page: visible, at: current == index && !wasPrepared ? point.applying(transform) : point))
                }
                self.replacing = false
            }
            for index in Array(self.originals.keys) where abs(index - center) > 4 {
                guard let original = self.originals.removeValue(forKey: index) else { continue }
                self.replacing = true; self.document.removePage(at: index); self.document.insert(original, at: index); self.preparedDocuments[index] = nil; self.preparedRevisions[index] = nil; self.replacing = false
            }
            for index in Array(self.canonicalPages.keys) where abs(index - center) > 4 { self.canonicalPages[index] = nil }
        }
    }
}
