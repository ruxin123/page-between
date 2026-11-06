import XCTest

final class ReadingFlowTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    @MainActor func testImmersiveSwipeAppearanceAndChapterSearch() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PAGE_BETWEEN_UI_TEST"] = "1"
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN", "-reading.fontScale", "100", "-reading.textScroll", "NO"]
        app.launch()
        let book = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Mobile reading sample")).firstMatch
        XCTAssertTrue(book.waitForExistence(timeout: 30)); openBook(book, in: app)
        app.buttons["目录"].tap()
        let search = app.searchFields.matching(NSPredicate(format: "placeholderValue == %@", "查找章节")).firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10)); search.tap(); search.typeText("开始")
        XCTAssertTrue(app.buttons["第一章 开始"].exists); XCTAssertFalse(app.buttons["第二章 继续"].exists)
        capture(app, "chapter-search"); app.buttons["第一章 开始"].tap()
        let position = app.descendants(matching: .any).matching(identifier: "reader.position").firstMatch
        XCTAssertTrue(position.waitForExistence(timeout: 10)); let before = position.label
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["目录"])
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        app.webViews.firstMatch.swipeLeft()
        capture(app, "swiped-immersive-page")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["目录"].waitForExistence(timeout: 10))
        XCTAssertNotEqual(position.label, before, "A horizontal swipe must advance reading progress")
        app.descendants(matching: .any).matching(identifier: "reader.appearance").firstMatch.tap()
        XCTAssertTrue(app.sliders["行距"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["紧凑"].exists); app.buttons["紧凑"].tap()
        app.sliders["行距"].adjust(toNormalizedSliderPosition: 0.4)
        capture(app, "reading-bottom-sheet")
        app.buttons["完成"].tap()
        XCTAssertTrue(app.buttons["目录"].waitForExistence(timeout: 5))
    }
    @MainActor func testImportOptionsAndIllustratedFB2() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PAGE_BETWEEN_IMPORT_UI_TEST"] = "1"
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let textToggle = app.switches["import.parse.Import options sample.txt"]
        XCTAssertTrue(textToggle.waitForExistence(timeout: 30)); XCTAssertEqual(textToggle.value as? String, "1")
        XCTAssertEqual(app.switches["import.parse.Original FB2 sample.fb2"].value as? String, "0")
        textToggle.switches.firstMatch.tap()
        let switchedOff = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "0"), object: textToggle)
        let result = XCTWaiter.wait(for: [switchedOff], timeout: 5)
        capture(app, "import-toggle-result")
        XCTAssertEqual(result, .completed, "Toggle value: \(String(describing: textToggle.value)); " + app.debugDescription)
        capture(app, "import-options"); app.navigationBars["导入书籍"].buttons["导入"].tap()
        let fb2 = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Original FB2 sample")).firstMatch
        XCTAssertTrue(fb2.waitForExistence(timeout: 30), app.debugDescription); openBook(fb2, in: app)
        XCTAssertTrue(app.buttons["目录"].waitForExistence(timeout: 20)); app.buttons["目录"].tap()
        XCTAssertTrue(app.buttons["第一章 FB2 开篇"].waitForExistence(timeout: 10)); app.buttons["第一章 FB2 开篇"].tap()
        let paragraph = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Original illustrated FB2 paragraph")).firstMatch
        XCTAssertTrue(paragraph.waitForExistence(timeout: 20)); assertReadable(paragraph, in: app); capture(app, "fb2-reader")
        app.buttons["目录"].tap()
        XCTAssertTrue(app.buttons["Nested FB2 section"].waitForExistence(timeout: 10))
        app.buttons["Second FB2 chapter"].tap()
        XCTAssertTrue(app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Second original FB2 paragraph")).firstMatch.waitForExistence(timeout: 15))
        app.buttons["书库"].tap()
        let plain = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Import options sample")).firstMatch
        XCTAssertTrue(plain.waitForExistence(timeout: 10)); openBook(plain, in: app)
        XCTAssertTrue(app.buttons["目录"].waitForExistence(timeout: 20)); app.buttons["目录"].tap()
        XCTAssertTrue(app.buttons["全文"].waitForExistence(timeout: 10)); XCTAssertFalse(app.buttons["第二章 继续"].exists)
    }
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
        tapSelectionAction("复制 LaTeX", in: app)
        app.buttons["reader.more"].tap(); app.buttons["提问最近选段"].tap()
        XCTAssertTrue(app.webViews["markdown.preview"].waitForExistence(timeout: 10))
        let renderedFormula = app.webViews["markdown.preview"].descendants(matching: .any).matching(NSPredicate(format: "label == %@", "g(x)=x^2")).firstMatch
        let formulaReady = renderedFormula.waitForExistence(timeout: 15)
        capture(app, "complete-formula")
        XCTAssertTrue(formulaReady, app.debugDescription)
        app.buttons["完成"].tap()
        let damaged = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "a + b")).firstMatch
        XCTAssertTrue(damaged.waitForExistence(timeout: 5), app.debugDescription); damaged.tap()
        tapSelectionAction("提问", in: app)
        XCTAssertTrue(app.images["原书公式"].waitForExistence(timeout: 15), app.debugDescription)
        capture(app, "original-formula-fallback")
        app.buttons["完成"].tap()
        let table = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "f(x)")).firstMatch
        XCTAssertTrue(table.waitForExistence(timeout: 5), app.debugDescription); table.tap()
        tapSelectionAction("提问", in: app)
        XCTAssertTrue(app.webViews["markdown.preview"].staticTexts["f(x)"].waitForExistence(timeout: 15), app.debugDescription)
        capture(app, "complete-table")
        app.buttons["完成"].tap()
        let diagram = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Original diagram")).firstMatch
        XCTAssertTrue(diagram.waitForExistence(timeout: 5), app.debugDescription)
        diagram.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 5)).tap()
        tapSelectionAction("复制原图", in: app)
        app.buttons["reader.more"].tap()
        XCTAssertFalse(app.buttons["翻译最近选段"].exists)
        app.buttons["提问最近选段"].tap()
        XCTAssertTrue(app.images["原书图像"].waitForExistence(timeout: 15), app.debugDescription)
        capture(app, "complete-image")
        app.buttons["保存到页边"].tap()
        app.buttons["完成"].tap()
        app.buttons["reader.more"].tap(); app.buttons["页边"].tap()
        let excerpt = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "excerpt.row.")).firstMatch
        XCTAssertTrue(excerpt.waitForExistence(timeout: 10), app.debugDescription)
        excerpt.tap()
        let note = app.descendants(matching: .any).matching(identifier: "excerpt.note").firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 10)); note.tap(); note.typeText("Original thought")
        app.buttons["保存笔记"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Original thought")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(excerpt.waitForExistence(timeout: 10)); excerpt.tap()
        XCTAssertTrue(note.waitForExistence(timeout: 10)); XCTAssertTrue((note.value as? String ?? "").contains("Original thought"))
        app.buttons["删除"].tap()
        XCTAssertTrue(app.buttons["撤销删除"].waitForExistence(timeout: 10)); app.buttons["撤销删除"].tap()
        XCTAssertTrue(excerpt.waitForExistence(timeout: 10))
        app.buttons["导出"].tap(); app.buttons["JSON"].tap()
        XCTAssertTrue(app.buttons["存储或分享导出"].waitForExistence(timeout: 15), app.debugDescription)
        capture(app, "saved-image-excerpt")
        excerpt.tap(); app.buttons["返回原文"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "reader.pdf").firstMatch.waitForExistence(timeout: 10))
    }
    @MainActor func testTransferImportProgressBookmarksAndExport() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PAGE_BETWEEN_TRANSFER_UI_TEST"] = "1"
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.staticTexts["已导入 1 本，保留 0 本已有书籍。"].waitForExistence(timeout: 45), app.debugDescription)
        capture(app, "transfer-import")
        app.buttons["完成"].tap()
        let book = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Original transfer sample")).firstMatch
        XCTAssertTrue(book.waitForExistence(timeout: 10)); openBook(book, in: app)
        XCTAssertTrue(app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Original transferred second paragraph")).firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        app.buttons["目录"].tap(); app.buttons["书签"].tap()
        XCTAssertTrue(app.buttons["Transfer bookmark"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["Transfer bookmark"].tap()
        XCTAssertTrue(app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Original transferred paragraph")).firstMatch.waitForExistence(timeout: 15))
        app.buttons["书库"].tap(); app.buttons["library.more"].tap(); app.buttons["设备迁移"].tap()
        app.buttons["导出迁移包"].tap()
        XCTAssertTrue(app.buttons["发送或存储迁移包"].waitForExistence(timeout: 45), app.debugDescription)
        capture(app, "transfer-export")
        app.buttons["发送或存储迁移包"].tap()
        let filesAction = app.descendants(matching: .any).matching(NSPredicate(format: "(label CONTAINS %@ AND (label BEGINSWITH %@ OR label BEGINSWITH %@)) OR label == %@", "文件", "保存", "存储", "Save to Files")).firstMatch
        XCTAssertTrue(filesAction.waitForExistence(timeout: 15), app.debugDescription)
        let share = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        share.name = "transfer-share"; share.lifetime = .keepAlways; add(share)
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
        app.buttons["页段与重新准备"].tap()
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
        let previewReady = app.webViews["markdown.preview"].staticTexts.firstMatch.waitForExistence(timeout: 8)
        capture(app, "scanned-selection")
        XCTAssertTrue(previewReady, app.debugDescription)
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
        app.descendants(matching: .any).matching(identifier: "reader.appearance").firstMatch.tap()
        app.sliders.firstMatch.adjust(toNormalizedSliderPosition: 0.6)
        app.buttons["完成"].tap()
        assertReadable(paragraph, in: app)
        paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.15)).press(forDuration: 1.2)
        let ask = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "提问")).firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5), app.debugDescription)
        ask.tap()
        XCTAssertTrue(app.navigationBars["书内答疑"].waitForExistence(timeout: 5), app.debugDescription)
        let quote = app.webViews["markdown.preview"].staticTexts.firstMatch
        let quoteRendered = quote.waitForExistence(timeout: 8)
        capture(app, "selection-preview-result")
        XCTAssertTrue(quoteRendered, "Selected text preview did not render: " + app.debugDescription)
        XCTAssertTrue(quote.isHittable)
        capture(app, "selected-source")
        app.buttons["完成"].tap()
        app.buttons["reader.more"].tap()
        app.buttons["提问最近选段"].tap()
        XCTAssertTrue(app.navigationBars["书内答疑"].waitForExistence(timeout: 5))
    }
    @MainActor private func tapSelectionAction(_ title: String, in app: XCUIApplication) {
        let action = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", title)).firstMatch
        for _ in 0..<4 {
            if action.waitForExistence(timeout: 1), action.isHittable { action.tap(); return }
            let forward = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "前进", "Forward")).firstMatch
            guard forward.waitForExistence(timeout: 1) else { break }
            forward.tap()
        }
        XCTFail("Selection menu action is unavailable: " + title + "\n" + app.debugDescription)
    }
    @MainActor private func openBook(_ book: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<5 {
            let center = book.frame.midY
            if center > app.frame.minY + 180 && center < app.frame.maxY - 140 { break }
            if center >= app.frame.maxY - 140 { app.scrollViews.firstMatch.swipeUp() }
            else { app.scrollViews.firstMatch.swipeDown() }
        }
        book.tap()
        let content = app.descendants(matching: .any).matching(identifier: "reader.pdf").firstMatch
        if !app.webViews.firstMatch.waitForExistence(timeout: 3) { XCTAssertTrue(content.waitForExistence(timeout: 20)) }
        if !content.exists { XCTAssertTrue(app.webViews.staticTexts.firstMatch.waitForExistence(timeout: 30), "Reader content has not loaded") }
        XCTAssertFalse(app.buttons["目录"].isHittable, "A book should open without toolbars")
        capture(app, "immersive-reader")
        if content.exists { content.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.9)).tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        XCTAssertTrue(app.buttons["目录"].waitForExistence(timeout: 10), app.debugDescription)
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
