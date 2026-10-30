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

@MainActor final class MobilePDFNavigator: UIViewController, @preconcurrency Navigator, PDFViewDelegate, UIGestureRecognizerDelegate {
    let publication: Publication
    let book: MobileBook
    let preparation: PDFPreparationStore
    weak var delegate: NavigatorDelegate?
    var onTap: (() -> Void)?
    var onJump: ((Locator) -> Void)?
    var onCopy: (() -> Void)?
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
        pdf.backgroundColor = .secondarySystemBackground
        pdf.minScaleFactor = 0.25; pdf.maxScaleFactor = 4
        pdf.copySource = { [weak self] in self?.onCopy?() }
        pdf.askSource = { [weak self] in self?.onAsk?(false) }
        pdf.translateSource = { [weak self] in self?.onAsk?(true) }
        pdf.resolveDestination = { [weak self] in self?.destination($0) ?? $0 }
        applyScroll(continuous)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.cancelsTouchesInView = false; tap.delegate = self; pdf.addGestureRecognizer(tap)
        for name in [Notification.Name.PDFViewPageChanged, .PDFViewVisiblePagesChanged] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: pdf, queue: .main) { [weak self] _ in Task { @MainActor in self?.changed() } })
        }
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
    func selectedSource(translate: Bool) throws -> AssistantSelection {
        guard let selection = pdf.currentSelection, let text = selection.string, !text.isEmpty, let page = selection.pages.first else { throw ServiceError.message("请先长按选择一段文字。") }
        let index = document.index(for: page), bounds = page.bounds(for: .cropBox), rectangle = selection.bounds(for: page)
        guard index != NSNotFound, let locator = location(page: index, quote: text, y: Double((bounds.maxY - rectangle.maxY) / bounds.height)) else { throw LibraryFailure.invalidFile }
        return AssistantSelection(book: book.id, quote: text, locator: try locator.jsonString(), translate: translate)
    }
    var hasSelection: Bool { !(pdf.currentSelection?.string ?? "").isEmpty }
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
    @objc private func tapped() { if !hasSelection { onTap?() } }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
    private func changed() {
        guard !replacing, let currentLocation else { return }
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
                guard let data = try? await self.preparation.repository.pdfPage(self.book.id, page: index + 1), data.ocrCompleted, !data.hasNativeText, !data.words.isEmpty,
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
        }
    }
}
