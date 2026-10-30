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
                    await UITestFixtures.prepare(store)
                    #endif
                }
            case .failure(let error): ContentUnavailableView("书库暂时无法打开", systemImage: "books.vertical", description: Text(error.localizedDescription))
            }
        }
    }
}
