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
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MarkdownWebView(text: text, images: images, height: $height, failed: $failed, pending: $pending).frame(height: failed ? 0 : height).accessibilityHidden(failed)
                .overlay { if pending && !failed { ProgressView() } }
            if failed { Text(text).font(.body).textSelection(.enabled) }
        }
    }
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
            view.load(URLRequest(url: URL(string: "\(MarkdownResources.scheme)://bundle/markdown.html")!))
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.parent = self; context.coordinator.render(view) }
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: MarkdownWebView
        var loaded = false
        var revision = 0
        var lastText: String?
        var lastImages: [MarkdownSourceImage] = []
        init(_ parent: MarkdownWebView) { self.parent = parent }
        func phase(_ view: WKWebView, _ name: String) {
            #if DEBUG
            view.accessibilityValue = ((view.accessibilityValue ?? "").split(separator: ">").suffix(7).map(String.init) + [name]).joined(separator: ">")
            #endif
        }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { phase(webView, "started") }
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { phase(webView, "committed") }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "markdownReady", message.body as? String == "ready", message.frameInfo.isMainFrame, let view = message.webView else { return }
            phase(view, "script-ready")
            loaded = true; lastText = nil; render(view)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            phase(webView, "loaded")
            webView.evaluateJavaScript("typeof window.renderMarkdown === 'function'") { [weak self] value, _ in
                if value as? Bool != true { self?.parent.failed = true }
            }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.failed = true }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.failed = true }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { loaded = false; parent.failed = true }
        func render(_ view: WKWebView) {
            guard loaded, parent.text != lastText || parent.images != lastImages else { return }
            lastText = parent.text
            lastImages = parent.images
            phase(view, "rendering")
            revision += 1; let generation = revision
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let value = try? await view.callAsyncJavaScript("return await window.renderMarkdown(text, images)", arguments: ["text": self.parent.text, "images": self.parent.images.map(\.json)], in: nil, contentWorld: .page), generation == self.revision, let size = value as? Double {
                    let height = max(40, CGFloat(size))
                    self.parent.failed = false
                    self.parent.pending = false
                    self.phase(view, "rendered")
                    if abs(self.parent.height - height) > 1 { self.parent.height = height }
                } else if generation == self.revision { self.parent.failed = true }
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
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
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else { return }
        let load = loadPreview
        loadPreview = nil
        load?()
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
