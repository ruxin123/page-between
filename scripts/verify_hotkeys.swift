// swiftc -parse-as-library native/Palm.swift scripts/verify_hotkeys.swift -o /tmp/page-between-hotkeys
// Checks Carbon routing and the WebKit bridge; physical OS key delivery is a separate check.
import AppKit
import Carbon
import WebKit

@MainActor final class HotkeyVerification: NSObject, NSApplicationDelegate {
    var palm: PalmDelegate!
    var failure: String?
    struct Failure: Error { let message: String }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Task { await run() }
    }
    func check(_ value: Bool, _ message: String) throws {
        if !value { throw Failure(message: message) }
    }
    func wait(_ predicate: () async throws -> Bool) async throws {
        let end = Date().addingTimeInterval(15)
        while Date() < end {
            if try await predicate() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw Failure(message: "Timed out waiting for Carbon / WebKit delivery")
    }
    func post(signature: OSType = 0x594A504D, id: UInt32, parameters: Bool = true) throws {
        var event: EventRef?
        try check(CreateEvent(nil, OSType(kEventClassKeyboard), UInt32(kEventHotKeyPressed), 0, .zero, &event) == noErr, "CreateEvent failed")
        guard let event = event else { throw Failure(message: "Missing event") }
        defer { ReleaseEvent(event) }
        if parameters {
            var identity = EventHotKeyID(signature: signature, id: id)
            try check(SetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), MemoryLayout<EventHotKeyID>.size, &identity) == noErr, "SetEventParameter failed")
        }
        _ = SendEventToEventTarget(event, GetEventDispatcherTarget())
    }
    func run() async {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("page-between-hotkeys-" + UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            palm = PalmDelegate(address: URL(string: "http://127.0.0.1:9/")!, statusFile: root.appendingPathComponent("status.json"))
            palm.panel = ReaderPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
            palm.web = WKWebView(frame: palm.panel.contentView!.bounds)
            palm.web.navigationDelegate = palm
            palm.panel.contentView = palm.web
            palm.web.loadHTMLString("<html><body><script>window.turns=[];window.addEventListener('palm-flip',e=>window.turns.push(e.detail));</script></body></html>", baseURL: palm.address)
            try await wait { self.palm.loaded }
            palm.registerHotkeys()
            try check(palm.hotkeyHandlerStatus == noErr && palm.hotkeys.count == 2, "Shortcuts did not register")
            NSApp.deactivate()
            try await wait { !NSApp.isActive }
            try post(id: 1)
            try post(id: 2)
            try await wait {
                let turns = try await self.palm.web.callAsyncJavaScript("return window.turns", arguments: [:], in: nil, contentWorld: .page) as? [Int]
                return turns == [1, -1]
            }
            try check(palm.receivedHotkeys == 2 && palm.lastHotkeyWasBackground, "Inactive app did not receive routed callbacks")
            try check(palm.hotkeyDispatchError.isEmpty, "WebKit dispatch failed")
            try post(signature: 0x51515151, id: 1)
            try post(id: 7)
            try post(id: 1, parameters: false)
            try check(palm.receivedHotkeys == 2, "Unrelated or malformed shortcuts were consumed")
            palm.configureHotkeys("letters")
            palm.registerHotkeys()
            try check(palm.shortcutPreset == "letters" && palm.hotkeys.count == 2, "Alternate shortcuts did not register")
            for (code, occupied) in [(UInt32(45), true), (35, true), (123, false), (124, false)] {
                var reference: EventHotKeyRef?
                let status = RegisterEventHotKey(code, UInt32(controlKey | optionKey | cmdKey), EventHotKeyID(signature: 0x51515453, id: code), GetEventDispatcherTarget(), 0, &reference)
                if let reference = reference { UnregisterEventHotKey(reference) }
                try check((status != noErr) == occupied, "Changing preset did not move the actual registered keys")
            }
            palm.configureHotkeys("off")
            palm.registerHotkeys()
            try check(palm.hotkeys.isEmpty && palm.eventHandler == nil, "Disabled shortcuts remained registered")
            palm.configureHotkeys("untrusted-preset")
            try check(palm.shortcutPreset == "off", "Unknown presets changed the shortcut configuration")
            palm.stopHotkeys()
            try post(id: 1)
            try check(palm.hotkeys.isEmpty && palm.eventHandler == nil && palm.receivedHotkeys == 2, "Closed windows retained their handler")
            print("PASS: inactive Carbon dispatcher, both directions, WebKit delivery, invalid events, preset rebinding, disable and handler cleanup")
            print("Physical key delivery from another app was not synthesized by this test.")
        } catch {
            failure = String(describing: error)
            print("FAIL:", failure!)
        }
        palm?.stopHotkeys()
        try? FileManager.default.removeItem(at: root)
        RunLoop.main.perform { NSApp.terminate(nil) }
    }
}

@main struct HotkeyCheckApplication {
    static func main() {
        let app = NSApplication.shared, check = HotkeyVerification()
        app.delegate = check
        withExtendedLifetime(check) { app.run() }
        if check.failure != nil { exit(1) }
    }
}
