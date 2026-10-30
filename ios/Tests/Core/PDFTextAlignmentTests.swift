import XCTest
@testable import PageBetweenCore

final class PDFTextAlignmentTests: XCTestCase {
    func testCorrectsOnlySelectedWordsAndKeepsOriginalFormula() throws {
        let raw = "A functlon has a unique output.", canonical = "A function has a unique output."
        XCTAssertEqual(PDFTextAlignment.selected(raw, canonical: canonical, ranges: [(raw as NSString).range(of: "functlon")]), "function")
        let original = "若 A∩B=∅，则两集合不相交。", target = #"若 $A\cap B=\varnothing$，则两集合不相交。"#
        XCTAssertEqual(PDFTextAlignment.selected(original, canonical: target, ranges: [(original as NSString).range(of: "∅")]), #"$A\cap B=\varnothing$"#)
        XCTAssertNil(PDFTextAlignment.characterMap("unrelated page header", canonical: "Every function has one output."))
    }
    func testUTF16LigatureEmojiAndStandaloneBoundaries() throws {
        let mapping = try XCTUnwrap(PDFTextAlignment.characterMap("A deﬁnition 😀", canonical: "A definition 😀"))
        XCTAssertEqual(mapping.count, ("A deﬁnition 😀" as NSString).length)
        XCTAssertEqual(mapping[4], NSRange(location: 4, length: 2))
        XCTAssertEqual(mapping[mapping.count - 1], mapping[mapping.count - 2])
        XCTAssertEqual(PDFTextAlignment.standaloneFormula(#"$x^2$;"#), "x^2")
        XCTAssertNil(PDFTextAlignment.standaloneFormula("For $x$ and $y$, consider this."))
        XCTAssertNil(PDFTextAlignment.standaloneFormula("$$x$$\n\nordinary text\n\n$$y$$"))
        XCTAssertNil(PDFTextAlignment.selected("x", canonical: "x", ranges: [NSRange(location: 100, length: 1)]))
    }
    func testWholeObjectsMixedSelectionAndUnknownTextRemainIntact() throws {
        let blocks = [PDFContentBlock(id: "text", type: "text", text: "A function.", box: PDFBox(0.1,0.1,0.9,0.2), order: 0), PDFContentBlock(id: "math", type: "equation", text: #"x^2=\emptyset"#, box: PDFBox(0.1,0.3,0.9,0.4), order: 1), PDFContentBlock(id: "table", type: "table", text: "x\tf(x)\n1\t1", box: PDFBox(0.1,0.5,0.9,0.7), order: 2)]
        let glyphs = [PDFSourceGlyph(text: "A functlon.", box: PDFBox(0.1,0.12,0.8,0.18), selected: true), PDFSourceGlyph(text: "poor OCR", box: PDFBox(0.2,0.32,0.4,0.38), selected: true), PDFSourceGlyph(text: "one cell", box: PDFBox(0.2,0.55,0.4,0.6), selected: true), PDFSourceGlyph(text: "Unparsed footer", box: PDFBox(0.1,0.9,0.7,0.94), selected: true)]
        let result = PDFSelectionAssembler.assemble(glyphs, blocks: blocks, page: 31)
        XCTAssertEqual(result.raw, "A function.\n\nx^2=\\emptyset\n\nx\tf(x)\n1\t1\n\nUnparsed footer")
        XCTAssertTrue(result.markdown.contains("$$\nx^2=\\emptyset\n$$"))
        XCTAssertEqual(result.objects.map(\.type), ["equation", "table"])
        XCTAssertEqual(result.objects.map(\.page), [31,31])
        let text = String(repeating: "A long original paragraph. ", count: 300)
        XCTAssertNotNil(PDFTextAlignment.characterMap(text, canonical: text))
    }
    func testInlineFormulaCropUsesOnlyMappedGlyphsAndKeepsDamagedSource() throws {
        let glyphs = [PDFSourceGlyph(text: "For ", box: PDFBox(0.1,0.1,0.2,0.14), selected: true), PDFSourceGlyph(text: "a+b", box: PDFBox(0.21,0.1,0.3,0.14), selected: true), PDFSourceGlyph(text: ", continue.", box: PDFBox(0.31,0.1,0.7,0.14), selected: true)]
        let block = PDFContentBlock(id: "inline", type: "text", text: #"For $\overline{a+b$, continue."#, box: PDFBox(0.1,0.09,0.7,0.15), order: 0)
        let result = PDFSelectionAssembler.assemble(glyphs, blocks: [block], page: 4)
        XCTAssertEqual(result.raw, block.text)
        XCTAssertEqual(result.objects.count, 1)
        XCTAssertEqual(result.objects.first?.text, #"$\overline{a+b$"#)
        XCTAssertEqual(result.objects.first?.box, glyphs[1].box)
        var partial = glyphs
        partial[1].selected = false
        XCTAssertTrue(PDFSelectionAssembler.assemble(partial, blocks: [block], page: 4).objects.isEmpty)
        let dotted = "Foreword ............ ix\nOverview and introduction to functions ............ 1"
        XCTAssertEqual(PDFTextAlignment.selected(dotted, canonical: "Foreword ix\nOverview and introduction to functions 1", ranges: [NSRange(location: 0, length: 15)]), "Foreword")
    }
}
