import XCTest

final class ReadingFlowTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    @MainActor func testAIStreamingStopReopenAndRetry() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PAGE_BETWEEN_UI_TEST"] = "1"
        app.launchEnvironment["PAGE_BETWEEN_AI_UI_TEST"] = "1"
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let book = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Mobile reading sample")).firstMatch
        XCTAssertTrue(book.waitForExistence(timeout: 30)); openBook(book, in: app)
        XCTAssertTrue(app.buttons["目录"].waitForExistence(timeout: 20)); app.buttons["目录"].tap()
        let chapter = app.buttons["第二章 继续"]
        let chapterAppeared = chapter.waitForExistence(timeout: 10)
        if !chapterAppeared { capture(app, "missing-chapter") }
        XCTAssertTrue(chapterAppeared); chapter.tap()
        let paragraph = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Second original paragraph")).firstMatch
        XCTAssertTrue(paragraph.waitForExistence(timeout: 30)); assertReadable(paragraph, in: app)
        paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.15)).press(forDuration: 1.2)
        let ask = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "提问")).firstMatch
        let menuAppeared = ask.waitForExistence(timeout: 6)
        if !menuAppeared { capture(app, "missing-selection-menu") }
        XCTAssertTrue(menuAppeared); ask.tap()
        let field = app.descendants(matching: .any)["assistant.question"]
        XCTAssertTrue(field.waitForExistence(timeout: 10)); field.tap(); field.typeText("Explain original streaming")
        app.buttons["发送提问"].tap()
        let partial = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Original streamed")).firstMatch
        XCTAssertTrue(partial.waitForExistence(timeout: 10)); app.buttons["停止"].tap()
        XCTAssertTrue(app.staticTexts["已停止"].waitForExistence(timeout: 10)); capture(app, "ai-stopped")
        app.buttons["完成"].tap(); app.buttons["reader.more"].tap(); app.buttons["答疑记录"].tap()
        let saved = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Explain original streaming")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10)); saved.tap()
        XCTAssertTrue(app.staticTexts["已停止"].waitForExistence(timeout: 10))
        app.buttons["重新生成"].tap()
        let result = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Original completed")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 15)); capture(app, "ai-completed")
        XCTAssertFalse(app.staticTexts["已停止"].exists)
    }
    @MainActor func testPDFCompleteObjectsAndOriginalFormulaFallback() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PAGE_BETWEEN_PDF_OBJECT_UI_TEST"] = "1"
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let book = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Original object sample")).firstMatch
        XCTAssertTrue(book.waitForExistence(timeout: 30), app.debugDescription); openBook(book, in: app)
        let formula = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "g(x) = x2")).firstMatch
        XCTAssertTrue(formula.waitForExistence(timeout: 20), app.debugDescription)
        formula.tap()
        let copy = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "复制 LaTeX")).firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5), app.debugDescription); copy.tap()
        app.buttons["reader.more"].tap(); app.buttons["提问最近选段"].tap()
        XCTAssertTrue(app.webViews["markdown.preview"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews["markdown.preview"].staticTexts.firstMatch.waitForExistence(timeout: 15))
        capture(app, "complete-formula")
        app.buttons["完成"].tap()
        let damaged = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "a + b")).firstMatch
        XCTAssertTrue(damaged.waitForExistence(timeout: 5), app.debugDescription); damaged.tap()
        let ask = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "提问")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5), app.debugDescription); ask.tap()
        XCTAssertTrue(app.images["原书公式"].waitForExistence(timeout: 15), app.debugDescription)
        capture(app, "original-formula-fallback")
        app.buttons["完成"].tap()
        let table = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "f(x)")).firstMatch
        XCTAssertTrue(table.waitForExistence(timeout: 5), app.debugDescription); table.tap()
        XCTAssertTrue(ask.waitForExistence(timeout: 5), app.debugDescription); ask.tap()
        XCTAssertTrue(app.webViews["markdown.preview"].staticTexts["f(x)"].waitForExistence(timeout: 15), app.debugDescription)
        capture(app, "complete-table")
        app.buttons["完成"].tap()
        let diagram = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Original diagram")).firstMatch
        XCTAssertTrue(diagram.waitForExistence(timeout: 5), app.debugDescription)
        diagram.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 5)).tap()
        let copyImage = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "复制原图")).firstMatch
        XCTAssertTrue(copyImage.waitForExistence(timeout: 5), app.debugDescription); copyImage.tap()
        app.buttons["reader.more"].tap()
        XCTAssertFalse(app.buttons["翻译最近选段"].exists)
        app.buttons["提问最近选段"].tap()
        XCTAssertTrue(app.images["原书图像"].waitForExistence(timeout: 15), app.debugDescription)
        capture(app, "complete-image")
    }
    @MainActor func testScannedPDFPreparationNavigationAndSelection() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PAGE_BETWEEN_PDF_UI_TEST"] = "1"
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let book = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Original scan sample")).firstMatch
        XCTAssertTrue(book.waitForExistence(timeout: 30), app.debugDescription)
        openBook(book, in: app)
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
        app.buttons["书库"].tap(); XCTAssertTrue(book.waitForExistence(timeout: 5)); openBook(book, in: app)
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
        openBook(book, in: app)
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
        openBook(book, in: app)
        XCTAssertTrue(paragraph.waitForExistence(timeout: 30), "Reading progress did not survive reopening: " + app.debugDescription)
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
        paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.15)).press(forDuration: 1.2)
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
    @MainActor private func openBook(_ book: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<5 {
            let center = book.frame.midY
            if center > app.frame.minY + 180 && center < app.frame.maxY - 140 { break }
            if center >= app.frame.maxY - 140 { app.scrollViews.firstMatch.swipeUp() }
            else { app.scrollViews.firstMatch.swipeDown() }
        }
        book.tap()
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
