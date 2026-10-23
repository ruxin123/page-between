// Original visible text and deliberately uneven OCR boxes; no book or cloud API is used.
const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert.ok(
  base && ["chromium", "webkit"].includes(engine),
  "READER_URL chromium|webkit",
);
const normalize = (text) => text.replace(/\s+/g, " ").trim();
(async () => {
  const browser = await { chromium, webkit }[engine].launch({ headless: true });
  let cases = 0;
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
    await page.route(base + "/ocr-selection-check.html", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><link rel="stylesheet" href="/layout.css"></head><body data-theme="paper"><div id="fixture" class="pdf-page" style="position:relative;width:760px;height:240px;margin:40px;background:white"><svg width="760" height="240" aria-hidden="true" style="width:760px;height:240px;user-select:none;pointer-events:none"><g fill="black" font-family="Times New Roman" font-size="22"><text x="40" y="55">A quiet definition, filling and jumping.</text><text x="40" y="115">The efficient family verifies each relation.</text><text x="40" y="175">Thin letters: i, l, f; capitals W and A.</text></g></svg><div id="ocr" class="textLayer"></div></div></body></html>',
      }),
    );
    await page.goto(base + "/ocr-selection-check.html");
    const lines = await page.evaluate(async () => {
      const { renderOcrLayer, ocrTextUnits } = await import(
        "/ui/ocr-layer.mjs"
      );
      const { canonicalSelection } = await import("/ui/pdf-selection.mjs");
      const data = { engine: "tesseract-eng", lines: [] },
        rows = [];
      for (const element of document.querySelectorAll("svg text")) {
        const text = element.textContent,
          top = element.y.baseVal[0].value - 22,
          segments = [],
          positions = [];
        for (let i = 0; i < text.length; i++) {
          const start = element.getStartPositionOfChar(i).x,
            end = element.getEndPositionOfChar(i).x;
          positions.push([start, end]);
          if (text[i] === " ") {
            segments.at(-1).text += " ";
            continue;
          }
          const inset = Math.min(0.65, (end - start) * 0.12),
            lower = /[a-z]/.test(text[i]) && !/[bdfghjklpqty]/.test(text[i]),
            punct = /[.,;:]/.test(text[i]);
          const y = punct ? top + 18 : lower ? top + 7 : top;
          segments.push({
            text: text[i],
            bbox: [
              (start + inset) / 760,
              y / 240,
              (end - inset) / 760,
              (top + 22) / 240,
            ],
          });
        }
        data.lines.push({
          text,
          bbox: [
            40 / 760,
            top / 240,
            positions.at(-1)[1] / 760,
            (top + 22) / 240,
          ],
          segments,
        });
        rows.push({ text, top, positions });
      }
      window.originalOcrFixture = data;
      renderOcrLayer(
        document.querySelector("#ocr"),
        data,
        { width: 760, height: 240 },
        "en",
      );
      window.copyFixtureSelection = () =>
        getSelection().rangeCount
          ? canonicalSelection(
              getSelection().getRangeAt(0),
              document.querySelector("#fixture"),
            )
          : "";
      window.fixtureTextUnits = () =>
        ocrTextUnits(document.querySelector("#ocr"));
      return rows;
    });
    for (const zoom of [0.75, 1, 1.35]) {
      await page.locator("#fixture").evaluate((node, zoom) => {
        node.style.transform = `scale(${zoom})`;
        node.style.transformOrigin = "0 0";
      }, zoom);
      for (const [lineIndex, line] of lines.entries()) {
        const targets = [];
        for (let start = 1; start + 4 < line.text.length; start += 4)
          targets.push([start, start + 1], [start, start + 4]);
        for (const [start, end] of targets) {
          for (const y of [0.2, 0.5, 0.8]) {
            for (const reverse of [false, true]) {
              await page.mouse.click(10, 10);
              const rectangle = await page.locator("#fixture").boundingBox();
              const a = [
                rectangle.x +
                  (line.positions[start][0] +
                    (line.positions[start][1] - line.positions[start][0]) *
                      0.15) *
                    zoom,
                rectangle.y + (line.top + 22 * y) * zoom,
              ];
              const b = [
                rectangle.x +
                  (line.positions[end][0] +
                    (line.positions[end][1] - line.positions[end][0]) * 0.85) *
                    zoom,
                rectangle.y + (line.top + 22 * y) * zoom,
              ];
              await page.mouse.move(...(reverse ? b : a));
              await page.mouse.down();
              await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(resolve)),
              );
              await page.mouse.move(...(reverse ? a : b), { steps: 5 });
              await page.mouse.up();
              await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(resolve)),
              );
              const actual = normalize(
                await page.evaluate(() => getSelection().toString()),
              );
              assert.equal(
                actual,
                normalize(line.text.slice(start, end + 1)),
                JSON.stringify({
                  engine,
                  zoom,
                  lineIndex,
                  start,
                  end,
                  y,
                  reverse,
                }),
              );
              assert.equal(
                normalize(
                  await page.evaluate(() => window.copyFixtureSelection()),
                ),
                normalize(line.text.slice(start, end + 1)),
                "Copied text retains the selected boundaries",
              );
              cases++;
            }
          }
        }
      }
    }
    assert.equal(
      normalize(await page.evaluate(() => window.fixtureTextUnits().join(""))),
      normalize(lines.map((line) => line.text).join("\n")),
      "Question context keeps word boundaries",
    );
    const mixed = await page.evaluate(() => {
      const layer = document.querySelector("#ocr"),
        nodes = [...layer.querySelectorAll("span")].filter((node) =>
          node.textContent.trim(),
        );
      const mapped = nodes.filter((node) => node.dataset.ocrLine === "1"),
        text = window.originalOcrFixture.lines[1].text;
      const group = { text, nodes: mapped, math: [], whole: false },
        mapping = new Map();
      let offset = 0;
      for (const node of mapped) {
        const start = text.indexOf(node.textContent, offset);
        if (start < 0) throw new Error("Fixture character missing");
        mapping.set(node, {
          group,
          map: Array.from(node.textContent, (_, i) => [
            start + i,
            start + i + 1,
          ]),
        });
        offset = start + node.textContent.length;
      }
      layer._canonical = { nodes, mapped: mapping };
      const range = document.createRange();
      range.setStart(nodes[0].firstChild, 0);
      range.setEnd(mapped.at(-1).firstChild, mapped.at(-1).textContent.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return window.copyFixtureSelection();
    });
    assert.equal(
      normalize(mixed),
      normalize(lines[0].text + " " + lines[1].text),
      "Unmapped text retains spaces beside a corrected block",
    );
    const tableSelection = await page.evaluate(async () => {
      const { alignTextLayer } = await import("/ui/pdf-selection.mjs");
      const layer = document.querySelector("#ocr"),
        nodes = layer._canonical.nodes;
      const group = [...layer._canonical.mapped.values()][0].group;
      const body = {
        text: group.text,
        order: 2,
        spans: group.nodes.map((node) => ({
          index: nodes.indexOf(node),
          map: layer._canonical.mapped.get(node).map,
        })),
        math: [],
      };
      await alignTextLayer(
        layer,
        [{ type: "table", text: "x\tf(x)\n2\t4" }],
        async () => ({
          groups: [
            {
              text: "x\tf(x)\n2\t4",
              whole: true,
              bbox: [0.05, 0.25, 0.4, 0.36],
              order: 1,
              spans: [],
            },
            body,
          ],
        }),
        "fixture",
        1,
      );
      const range = document.createRange();
      range.setStart(nodes[0].firstChild, 0);
      range.setEnd(
        group.nodes.at(-1).firstChild,
        group.nodes.at(-1).textContent.length,
      );
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return window.copyFixtureSelection();
    });
    assert.equal(
      normalize(tableSelection),
      normalize(lines[0].text + " x\tf(x)\n2\t4 " + lines[1].text),
      "Whole table stays between its neighbouring text rows",
    );
    console.log(
      JSON.stringify({
        engine,
        retina: true,
        zooms: [0.75, 1, 1.35],
        forwardAndReverse: true,
        cases,
        preciseSelection: true,
        copiedBoundaries: true,
        questionContext: true,
        mixedCanonicalText: true,
        wholeObjectOrder: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
