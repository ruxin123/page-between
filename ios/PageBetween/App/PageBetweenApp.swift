import SwiftUI

@main struct PageBetweenApp: App {
    private let result: Result<LibraryStore, Error>
    init() { result = Result { try LibraryStore() } }
    var body: some Scene {
        WindowGroup {
            switch result {
            case .success(let store): LibraryScreen(store: store)
                .task {
                    #if DEBUG
                    if ProcessInfo.processInfo.environment["PAGE_BETWEEN_UI_TEST"] == "1" {
                        let file = FileManager.default.temporaryDirectory.appendingPathComponent("Mobile reading sample.txt")
                        let text = "第一章 开始\n\n" + String(repeating: "First original paragraph for mobile reading.\n\n", count: 30) + "第二章 继续\n\nSecond original paragraph for chapter navigation.\n\nEnd of the original sample."
                        do { try Data(text.utf8).write(to: file); await store.importFiles([file]); try? FileManager.default.removeItem(at: file) }
                        catch { store.error = error.localizedDescription }
                    }
                    #endif
                }
            case .failure(let error): ContentUnavailableView("书库暂时无法打开", systemImage: "books.vertical", description: Text(error.localizedDescription))
            }
        }
    }
}
