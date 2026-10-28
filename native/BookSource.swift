import AppKit
import WebKit

/// Third-party browsing has its own website store and no reader script bridge.
final class BookSourceWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
  WKDownloadDelegate
{
  static let homepage = URL(string: "https://z-lib.sk/")!
  static let maximumBytes: Int64 = 200 * 1024 * 1024
  static let formats = Set([
    "epub", "pdf", "txt", "mobi", "azw", "azw3", "fb2", "md", "markdown", "html", "htm", "docx",
    "odt", "rtf", "cbz",
  ])
  let window: NSWindow
  let web: WKWebView
  let address = NSTextField()
  let status = NSTextField(labelWithString: "")
  let progress = NSProgressIndicator()
  private let connectionError = NSTextField(wrappingLabelWithString: "暂时无法连接\n可切换左上角的书源地址，或稍后刷新。")
  var importBook: ((URL, Bool) async throws -> Void)?
  var showLibrary: (() -> Void)?
  private let preference: String
  private let cache: URL
  private let back = NSButton()
  private let forward = NSButton()
  private var observing: NSKeyValueObservation?
  private var jobs: [ObjectIdentifier: DownloadJob] = [:]
  private var pending: [URL] = []
  private var importing = false

  private final class DownloadJob {
    let download: WKDownload
    let directory: URL
    var file: URL?
    var observation: NSKeyValueObservation?
    init(_ download: WKDownload, directory: URL) {
      self.download = download
      self.directory = directory
    }
  }

  init(demo: Bool) {
    preference = "PageBetweenBookSource." + (demo ? "demo" : "personal")
    cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(
        "Page Between/Book Sources/" + (demo ? "Demo" : "Personal"), isDirectory: true)
    let config = WKWebViewConfiguration()
    if #available(macOS 14.0, *) {
      config.websiteDataStore = WKWebsiteDataStore(
        forIdentifier:
          UUID(
            uuidString: demo
              ? "908C51CA-E891-4E28-9DCB-129BD05C7622" : "6E095F01-3E15-4601-977D-6879E4B48A80")!)
    } else {
      config.websiteDataStore = .nonPersistent()
    }
    web = WKWebView(frame: .zero, configuration: config)
    window = NSWindow(
      contentRect: NSRect(x: 140, y: 160, width: 1100, height: 760),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    super.init()
    window.title = "找书 · 页间"
    window.minSize = NSSize(width: 780, height: 520)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.setFrameAutosaveName(preference)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = true
    buildChrome()
    observing = web.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
      guard let self = self else { return }
      self.progress.doubleValue = self.web.estimatedProgress
      self.progress.isHidden = self.web.estimatedProgress >= 1
      self.back.isEnabled = self.web.canGoBack
      self.forward.isEnabled = self.web.canGoForward
    }
  }

  static func remoteURL(_ url: URL) -> Bool {
    guard url.scheme == "https", url.user == nil, url.password == nil,
      let host = url.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")),
      host.contains("."), !host.contains(":"),
      host.split(separator: ".").last?.range(of: "^[a-z]{2,63}$", options: .regularExpression)
        != nil,
      host.range(of: "^[0-9.]+$", options: .regularExpression) == nil,
      ![".localhost", ".local", ".internal", ".home", ".lan"].contains(where: { host.hasSuffix($0) }
      )
    else { return false }
    return true
  }

  static func isBookResponse(_ response: URLResponse, canShow: Bool) -> Bool {
    let filename = response.suggestedFilename ?? ""
    let attachment =
      (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased()
      .hasPrefix("attachment") == true
    let bookFile = Self.formats.subtracting(["html", "htm"]).contains(
      (filename as NSString).pathExtension.lowercased())
    return !canShow || bookFile || attachment
  }

  private func buildChrome() {
    let bar = NSStackView()
    bar.orientation = .horizontal
    bar.spacing = 8
    func button(_ title: String, _ symbol: String, _ action: Selector) -> NSButton {
      let item = NSButton(title: title, target: self, action: action)
      item.bezelStyle = .rounded
      item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
      item.imagePosition = .imageOnly
      item.toolTip = title
      item.setAccessibilityLabel(title)
      return item
    }
    back.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "后退")
    back.target = self
    back.action = #selector(goBack)
    back.bezelStyle = .rounded
    back.isEnabled = false
    back.toolTip = "后退"
    back.setAccessibilityLabel("后退")
    forward.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "前进")
    forward.target = self
    forward.action = #selector(goForward)
    forward.bezelStyle = .rounded
    forward.isEnabled = false
    forward.toolTip = "前进"
    forward.setAccessibilityLabel("前进")
    address.placeholderString = "书源网址"
    address.setAccessibilityLabel("书源网址")
    address.target = self
    address.action = #selector(goToAddress)
    address.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let sources = NSPopUpButton()
    sources.addItems(withTitles: [
      "Z-Library", "z-lib.sk", "1lib.sk", "z-lib.gd", "z-library.website", "z-library.qa",
      "z-library.im",
    ])
    sources.target = self
    sources.action = #selector(chooseSource(_:))
    sources.setAccessibilityLabel("选择书源地址")
    for item in [
      back, forward, button("刷新", "arrow.clockwise", #selector(reload)), sources, address,
      button("清除登录", "person.crop.circle.badge.minus", #selector(clearLogin)),
      button("书库", "books.vertical", #selector(openLibrary)),
    ] as [NSView] { bar.addArrangedSubview(item) }
    progress.minValue = 0
    progress.maxValue = 1
    progress.style = .bar
    progress.isIndeterminate = false
    progress.isHidden = true
    let footer = NSStackView()
    footer.spacing = 12
    status.font = .systemFont(ofSize: 12)
    status.textColor = .secondaryLabelColor
    status.lineBreakMode = .byTruncatingTail
    status.setAccessibilityRole(.staticText)
    footer.addArrangedSubview(status)
    footer.addArrangedSubview(button("取消下载", "xmark.circle", #selector(cancelDownloads)))
    let content = NSView()
    window.contentView = content
    for child in [bar, progress, web, footer] {
      child.translatesAutoresizingMaskIntoConstraints = false
      content.addSubview(child)
    }
    connectionError.alignment = .center
    connectionError.font = .systemFont(ofSize: 16)
    connectionError.textColor = .secondaryLabelColor
    connectionError.isHidden = true
    connectionError.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(connectionError)
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
      bar.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
      bar.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
      address.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),
      progress.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 8),
      progress.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      progress.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      progress.heightAnchor.constraint(equalToConstant: 2),
      web.topAnchor.constraint(equalTo: progress.bottomAnchor, constant: 4),
      web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      web.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -8),
      footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
      footer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
      footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8),
      footer.heightAnchor.constraint(equalToConstant: 24),
      connectionError.centerXAnchor.constraint(equalTo: web.centerXAnchor),
      connectionError.centerYAnchor.constraint(equalTo: web.centerYAnchor),
      connectionError.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
    ])
  }

  func show() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if web.url == nil {
      let saved = UserDefaults.standard.string(forKey: preference).flatMap(URL.init(string:))
      load(saved.flatMap { Self.remoteURL($0) ? $0 : nil } ?? Self.homepage)
    }
  }
  func load(_ url: URL) {
    guard Self.remoteURL(url) else {
      status.stringValue = "请输入公开的 HTTPS 书源网址。"
      return
    }
    address.stringValue = url.absoluteString
    status.stringValue = "正在连接…"
    connectionError.isHidden = true
    web.load(URLRequest(url: url, timeoutInterval: 40))
  }
  @objc private func goBack() { web.goBack() }
  @objc private func goForward() { web.goForward() }
  @objc private func reload() { if web.url != nil { web.reload() } else { load(Self.homepage) } }
  @objc private func openLibrary() {
    showLibrary?()
    window.orderOut(nil)
  }
  @objc private func goToAddress() {
    let value = address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: value.contains("://") ? value : "https://" + value),
      Self.remoteURL(url)
    else {
      status.stringValue = "请输入公开的 HTTPS 书源网址。"
      return
    }
    UserDefaults.standard.set(url.absoluteString, forKey: preference)
    load(url)
  }
  @objc private func chooseSource(_ sender: NSPopUpButton) {
    guard sender.indexOfSelectedItem > 0, let title = sender.titleOfSelectedItem,
      let url = URL(string: "https://" + title + "/")
    else { return }
    UserDefaults.standard.set(url.absoluteString, forKey: preference)
    load(url)
    sender.selectItem(at: 0)
  }
  @objc private func clearLogin() {
    let prompt = NSAlert()
    prompt.messageText = "清除书源登录？"
    prompt.informativeText = "书库和阅读记录会保留。"
    prompt.addButton(withTitle: "清除登录")
    prompt.addButton(withTitle: "取消")
    prompt.beginSheetModal(for: window) { [weak self] result in
      guard let self = self, result == .alertFirstButtonReturn else { return }
      self.web.configuration.websiteDataStore.removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
      ) {
        self.web.reload()
      }
    }
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url, Self.remoteURL(url) || url.scheme == "blob" else {
      decisionHandler(.cancel)
      return
    }
    decisionHandler(action.shouldPerformDownload ? .download : .allow)
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    guard let url = response.response.url, Self.remoteURL(url) || url.scheme == "blob" else {
      decisionHandler(.cancel)
      return
    }
    decisionHandler(
      Self.isBookResponse(response.response, canShow: response.canShowMIMEType) ? .download : .allow
    )
  }
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if action.targetFrame == nil, let url = action.request.url, Self.remoteURL(url) {
      webView.load(action.request)
    }
    return nil
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    connectionError.isHidden = true
    address.stringValue = webView.url?.absoluteString ?? ""
    if status.stringValue == "正在连接…" { status.stringValue = "" }
    back.isEnabled = webView.canGoBack
    forward.isEnabled = webView.canGoForward
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    let failure = error as NSError
    // Turning navigation into a download interrupts that navigation normally.
    if failure.code != NSURLErrorCancelled
      && !(["WebKitErrorDomain", "WKErrorDomain"].contains(failure.domain) && failure.code == 102)
    {
      status.stringValue = "无法连接，可切换书源地址后重试。"
      progress.isHidden = true
      connectionError.isHidden = false
    }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    self.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
  }
  func webView(
    _ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload
  ) { begin(download) }
  func webView(
    _ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload
  ) { begin(download) }
  private func begin(_ download: WKDownload) {
    guard jobs.count + pending.count < 3 else {
      download.cancel()
      status.stringValue = "请等待当前下载完成。"
      return
    }
    let job = DownloadJob(download, directory: cache.appendingPathComponent(UUID().uuidString))
    jobs[ObjectIdentifier(download)] = job
    download.delegate = self
    status.stringValue = "正在下载…"
    job.observation = download.progress.observe(\.completedUnitCount) {
      [weak self, weak download] value, _ in
      guard let download = download else { return }
      if value.completedUnitCount > Self.maximumBytes {
        DispatchQueue.main.async {
          self?.discard(download)
          self?.status.stringValue = "文件超过 200 MB。"
        }
      }
    }
  }
  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void
  ) {
    guard let job = jobs[ObjectIdentifier(download)] else {
      completionHandler(nil)
      return
    }
    guard response.expectedContentLength <= Self.maximumBytes else {
      completionHandler(nil)
      discard(download)
      status.stringValue = "文件超过 200 MB。"
      return
    }
    let filename = (suggestedFilename as NSString).lastPathComponent
    guard !filename.isEmpty, filename.utf8.count <= 240,
      Self.formats.contains((filename as NSString).pathExtension.lowercased())
    else {
      completionHandler(nil)
      discard(download)
      status.stringValue = "这个下载不是支持的电子书。"
      return
    }
    do {
      try FileManager.default.createDirectory(at: job.directory, withIntermediateDirectories: true)
      let target = job.directory.appendingPathComponent(filename)
      job.file = target
      completionHandler(target)
    } catch {
      completionHandler(nil)
      discard(download)
      status.stringValue = "无法保存下载，请检查磁盘空间。"
    }
  }
  func download(
    _ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void
  ) {
    decisionHandler(request.url.map(Self.remoteURL) == true ? .allow : .cancel)
  }
  func downloadDidFinish(_ download: WKDownload) {
    guard let job = jobs.removeValue(forKey: ObjectIdentifier(download)), let file = job.file else {
      return
    }
    job.observation = nil
    guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0,
      size <= Self.maximumBytes
    else {
      try? FileManager.default.removeItem(at: job.directory)
      status.stringValue = "下载文件为空或超过 200 MB。"
      return
    }
    pending.append(file)
    offerImport()
  }
  private func offerImport() {
    guard !importing, !pending.isEmpty else { return }
    importing = true
    let file = pending.removeFirst()
    let prompt = NSAlert()
    prompt.messageText = "加入书库？"
    prompt.informativeText = file.lastPathComponent
    prompt.addButton(withTitle: "加入书库")
    prompt.addButton(withTitle: "取消")
    let parse = NSButton(checkboxWithTitle: "文档解析", target: nil, action: nil)
    parse.state = ["pdf", "txt"].contains(file.pathExtension.lowercased()) ? .on : .off
    prompt.accessoryView = parse
    window.makeKeyAndOrderFront(nil)
    prompt.beginSheetModal(for: window) { [weak self] result in
      guard let self = self else { return }
      Task { @MainActor in
        defer {
          try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
          self.importing = false
          self.offerImport()
        }
        guard result == .alertFirstButtonReturn else {
          self.status.stringValue = "已取消导入。"
          return
        }
        guard let importBook = self.importBook else {
          self.status.stringValue = "书库尚未就绪，请重新下载。"
          return
        }
        self.status.stringValue = "正在加入书库…"
        do {
          try await importBook(file, parse.state == .on)
          self.status.stringValue = "已加入书库。"
        } catch { self.status.stringValue = "导入失败，请检查文件后重新下载。" }
      }
    }
  }
  private func discard(_ download: WKDownload) {
    guard let job = jobs.removeValue(forKey: ObjectIdentifier(download)) else { return }
    download.cancel()
    job.observation = nil
    try? FileManager.default.removeItem(at: job.directory)
  }
  @objc private func cancelDownloads() {
    for job in Array(jobs.values) { discard(job.download) }
    status.stringValue = "下载已取消。"
  }
  func shutdown() {
    for job in Array(jobs.values) { discard(job.download) }
    for file in pending {
      try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
    pending.removeAll()
    web.stopLoading()
    window.orderOut(nil)
  }
  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    guard jobs[ObjectIdentifier(download)] != nil else { return }
    discard(download)
    status.stringValue = "下载失败，请重试。"
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    window.orderOut(nil)
    return false
  }
}
