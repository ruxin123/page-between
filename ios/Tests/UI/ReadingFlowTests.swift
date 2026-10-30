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
        assertReadable(paragraph, in: app)
        capture(app, "reader")
        let bookmark = app.buttons["reader.bookmark"]
        if bookmark.label != "移除书签" { bookmark.tap() }
        app.buttons["书库"].tap()
        XCTAssertTrue(book.waitForExistence(timeout: 10))
        book.tap()
        XCTAssertTrue(paragraph.waitForExistence(timeout: 15), "Reading progress did not survive reopening")
        assertReadable(paragraph, in: app)
        app.buttons["目录"].tap()
        app.segmentedControls.buttons["书签"].tap()
        XCTAssertTrue(app.buttons["第二章 继续"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["完成"].tap()
        app.buttons["reader.more"].tap()
        app.buttons["阅读设置"].tap()
        app.sliders.firstMatch.adjust(toNormalizedSliderPosition: 0.6)
        app.buttons["完成"].tap()
        assertReadable(paragraph, in: app)
        paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.2)).press(forDuration: 1.2)
        let ask = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "提问")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5), app.debugDescription)
        ask.tap()
        XCTAssertTrue(app.navigationBars["书内答疑"].waitForExistence(timeout: 5), app.debugDescription)
        let quote = app.webViews["markdown.preview"].staticTexts.firstMatch
        XCTAssertTrue(quote.waitForExistence(timeout: 8), "Selected text preview did not render")
        XCTAssertTrue(quote.isHittable)
        capture(app, "selected-source")
        app.buttons["完成"].tap()
        app.buttons["reader.more"].tap()
        app.buttons["提问最近选段"].tap()
        XCTAssertTrue(app.navigationBars["书内答疑"].waitForExistence(timeout: 5))
    }
    @MainActor private func assertReadable(_ paragraph: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(paragraph.isHittable, "Paragraph is outside the visible page")
        XCTAssertLessThan(paragraph.frame.height, 160, "Unexpectedly large text size")
        XCTAssertGreaterThanOrEqual(paragraph.frame.minX, app.frame.minX - 2)
        XCTAssertLessThanOrEqual(paragraph.frame.maxX, app.frame.maxX + 2)
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
