import SwiftUI
import WebKit

struct MarkdownSourceImage: Equatable {
    let raw: String
    let data: Data
    var json: [String: String] { ["raw": raw, "src": "data:image/png;base64," + data.base64EncodedString()] }
}

struct MarkdownView: View {
    let text: String
    var images: [MarkdownSourceImage] = []
    @State private var height: CGFloat = 80
    @State private var failed = false
    @State private var pending = true
    @State private var attempt = 0
    @State private var canRetryAutomatically = true
    private var plainText: Bool {
        text.rangeOfCharacter(from: CharacterSet(charactersIn: "\\$*_`[]<>#~\r\n")) == nil &&
        text.range(of: #"^\s*(?:[-+]|[0-9]+[.)])\s"#, options: .regularExpression) == nil
    }
    var body: some View {
        if plainText {
            Text(text).font(.body).textSelection(.enabled).accessibilityIdentifier("markdown.plain")
        } else {
            VStack(alignment: .leading, spacing: 0) {
                MarkdownWebView(text: text, images: images, height: $height, failed: $failed, pending: $pending).id(attempt).frame(height: failed ? 0 : height).accessibilityHidden(failed)
                    .overlay { if pending && !failed { ProgressView() } }
                if failed {
                    Text(text).font(.body).textSelection(.enabled)
                    let formulas = Set(MathText.spans(text).map { $0.expression.trimmingCharacters(in: .whitespacesAndNewlines) })
                    ForEach(images.indices, id: \.self) { index in
                        let image = images[index]
                        if formulas.contains(image.raw.trimmingCharacters(in: .whitespacesAndNewlines)), let original = UIImage(data: image.data) {
                            Image(uiImage: original).resizable().scaledToFit().accessibilityLabel("原书公式")
                        }
                    }
                    Button("重新加载预览") { canRetryAutomatically = true; reload() }.font(.callout)
                }
            }
            .onChange(of: failed) {
                if failed && canRetryAutomatically { canRetryAutomatically = false; reload() }
            }
        }
    }
    private func reload() { failed = false; pending = true; attempt += 1 }
}

private struct MarkdownWebView: UIViewRepresentable {
    private static let dataStore = WKWebsiteDataStore.nonPersistent()
    let text: String
    let images: [MarkdownSourceImage]
    @Binding var height: CGFloat
    @Binding var failed: Bool
    @Binding var pending: Bool
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = Self.dataStore
        configuration.userContentController.add(context.coordinator, name: "markdownReady")
        configuration.setURLSchemeHandler(MarkdownResources(), forURLScheme: MarkdownResources.scheme)
        let view = MarkdownBrowser(frame: .zero, configuration: configuration)
        view.accessibilityIdentifier = "markdown.preview"
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.isScrollEnabled = false
        view.navigationDelegate = context.coordinator
        context.coordinator.phase(view, "requested")
        view.loadPreview = { [weak view, weak coordinator = context.coordinator] in
            guard let view else { return }
            coordinator?.phase(view, "attached")
            let navigation = view.load(URLRequest(url: URL(string: "\(MarkdownResources.scheme)://bundle/markdown.html")!))
            coordinator?.phase(view, navigation == nil ? "rejected" : "queued")
            if navigation == nil { coordinator?.fail() }
            else { coordinator?.watchRender() }
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.parent = self; context.coordinator.render(view) }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.timeout?.cancel()
        coordinator.revision += 1
        view.navigationDelegate = nil
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "markdownReady")
    }
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: MarkdownWebView
        var loaded = false
        var revision = 0
        var lastText: String?
        var lastImages: [MarkdownSourceImage] = []
        var timeout: Task<Void, Never>?
        var invalid = false
        init(_ parent: MarkdownWebView) { self.parent = parent }
        func phase(_ view: WKWebView, _ name: String) {
            #if DEBUG
            view.accessibilityValue = name
            #endif
        }
        func watchRender() {
            timeout?.cancel()
            timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                self?.fail()
            }
        }
        func fail() {
            guard !invalid else { return }
            invalid = true
            timeout?.cancel()
            revision += 1
            parent.failed = true
            parent.pending = false
        }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { phase(webView, "started") }
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { phase(webView, "committed") }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !invalid, message.name == "markdownReady", message.body as? String == "ready", message.frameInfo.isMainFrame, let view = message.webView else { return }
            phase(view, "script-ready")
            ready(view)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !invalid, !loaded else { return }
            phase(webView, "loaded")
            webView.evaluateJavaScript("typeof window.renderMarkdown === 'function'") { [weak self, weak webView] value, _ in
                if let webView, value as? Bool == true { self?.ready(webView) }
            }
        }
        private func ready(_ view: WKWebView) {
            guard !invalid, !loaded else { return }
            loaded = true
            render(view)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail() }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }
        func render(_ view: WKWebView) {
            guard !invalid, loaded, parent.text != lastText || parent.images != lastImages else { return }
            lastText = parent.text
            lastImages = parent.images
            phase(view, "rendering")
            revision += 1; let generation = revision
            watchRender()
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let value = try? await view.callAsyncJavaScript("return await window.renderMarkdown(text, images)", arguments: ["text": self.parent.text, "images": self.parent.images.map(\.json)], in: nil, contentWorld: .page), generation == self.revision, let size = value as? Double {
                    let height = max(40, CGFloat(size))
                    self.timeout?.cancel()
                    self.parent.pending = false
                    self.phase(view, "rendered")
                    if abs(self.parent.height - height) > 1 { self.parent.height = height }
                } else if generation == self.revision { self.fail() }
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            phase(webView, "policy-" + (navigationAction.request.url?.scheme ?? "none"))
            if navigationAction.navigationType == .linkActivated {
                if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
                decisionHandler(.cancel)
            } else {
                let url = navigationAction.request.url
                decisionHandler(url?.scheme == MarkdownResources.scheme && url?.host == "bundle" ? .allow : .cancel)
            }
        }
    }
}

private final class MarkdownBrowser: WKWebView {
    var loadPreview: (() -> Void)?
    private var loadScheduled = false
    override func didMoveToWindow() {
        super.didMoveToWindow()
        loadWhenReady()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        loadWhenReady()
    }
    private func loadWhenReady() {
        guard window != nil, bounds.width > 0, bounds.height > 0, loadPreview != nil, !loadScheduled else { return }
        loadScheduled = true
        // Start after WebKit finishes attaching a sized view to the presentation window.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.loadScheduled = false
            guard self.window != nil, self.bounds.width > 0, self.bounds.height > 0 else { return }
            let load = self.loadPreview
            self.loadPreview = nil
            load?()
        }
    }
}

// Serve only the packaged preview assets, without file-URL sandbox grants or a local server.
private final class MarkdownResources: NSObject, WKURLSchemeHandler {
    static let scheme = "page-between-preview"
    private static let files: [String: URL] = {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web") else { return [:] }
        var paths = ["markdown.html", "markdown.js", "vendor/marked.umd.js", "vendor/purify.min.js", "vendor/katex.min.js", "vendor/katex.min.css"]
        let fonts = root.appendingPathComponent("vendor/fonts")
        paths += ((try? FileManager.default.contentsOfDirectory(atPath: fonts.path)) ?? []).filter { $0.hasSuffix(".woff2") }.map { "vendor/fonts/" + $0 }
        return Dictionary(uniqueKeysWithValues: paths.map { ("/" + $0, root.appendingPathComponent($0)) })
    }()
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == Self.scheme, url.host == "bundle",
              urlSchemeTask.request.httpMethod == "GET", url.query == nil,
              let file = Self.files[url.path], let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let mime = ["html": "text/html", "js": "text/javascript", "css": "text/css", "woff2": "font/woff2"][file.pathExtension]!
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: file.pathExtension == "woff2" ? nil : "utf-8"))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
