import XCTest

final class ReadingFlowTests: XCTestCase {
    @MainActor func testImportSettingsChapterJumpAndProgress() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PAGE_BETWEEN_UI_TEST"] = "1"
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let book = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Mobile reading sample")).firstMatch
        XCTAssertTrue(book.waitForExistence(timeout: 30), app.debugDescription)
        capture(app, "library")
        app.buttons["library.more"].tap()
        app.buttons["设置"].tap()
        XCTAssertTrue(app.staticTexts["AI 答疑"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["API 地址"].exists)
        capture(app, "settings")
        app.buttons["取消"].tap()
        book.tap()
        XCTAssertTrue(app.buttons["目录"].waitForExistence(timeout: 20))
        app.buttons["目录"].tap()
        let chapter = app.buttons["第二章 继续"]
        XCTAssertTrue(chapter.waitForExistence(timeout: 10), app.debugDescription)
        chapter.tap()
        let paragraph = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Second original paragraph")).firstMatch
        XCTAssertTrue(paragraph.waitForExistence(timeout: 15), app.debugDescription)
        capture(app, "reader")
        app.buttons["书签"].tap()
        app.buttons["书库"].tap()
        XCTAssertTrue(book.waitForExistence(timeout: 10))
        book.tap()
        XCTAssertTrue(paragraph.waitForExistence(timeout: 15), "Reading progress did not survive reopening")
        app.buttons["目录"].tap()
        app.buttons["书签"].tap()
        XCTAssertTrue(app.buttons["第二章 继续"].waitForExistence(timeout: 5), app.debugDescription)
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
