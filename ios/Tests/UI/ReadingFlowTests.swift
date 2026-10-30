import XCTest

final class ReadingFlowTests: XCTestCase {
    @MainActor func testScannedPDFPreparationNavigationAndSelection() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PAGE_BETWEEN_PDF_UI_TEST"] = "1"
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let book = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Original scan sample")).firstMatch
        XCTAssertTrue(book.waitForExistence(timeout: 30), app.debugDescription)
        book.tap()
        XCTAssertTrue(app.buttons["reader.more"].waitForExistence(timeout: 15))
        app.buttons["reader.more"].tap(); app.buttons["文档处理"].tap()
        XCTAssertTrue(app.buttons["准备整本"].waitForExistence(timeout: 5))
        app.buttons["准备整本"].tap()
        XCTAssertTrue(app.staticTexts["已完成"].waitForExistence(timeout: 60), app.debugDescription)
        let range = app.textFields["页段，例如 1-20,35"]
        range.tap(); range.typeText("2")
        app.buttons["重新准备所选页"].tap()
        XCTAssertTrue(app.staticTexts["已完成"].waitForExistence(timeout: 60), app.debugDescription)
        capture(app, "pdf-preparation")
        app.buttons["完成"].tap()
        app.buttons["下一页"].tap()
        XCTAssertTrue(app.staticTexts["第 2 页"].waitForExistence(timeout: 10), app.debugDescription)
        capture(app, "scanned-pdf")
        app.buttons["书库"].tap(); XCTAssertTrue(book.waitForExistence(timeout: 5)); book.tap()
        XCTAssertTrue(app.staticTexts["第 2 页"].waitForExistence(timeout: 15), "Prepared page references changed the stored page number")
        let text = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Read page two")).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 15), app.debugDescription)
        text.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).press(forDuration: 1.2)
        let ask = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "提问")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 6), app.debugDescription)
        ask.tap()
        XCTAssertTrue(app.navigationBars["书内答疑"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.webViews["markdown.preview"].staticTexts.firstMatch.waitForExistence(timeout: 8))
        capture(app, "scanned-selection")
    }
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
