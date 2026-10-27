// First run verify_ocr_geometry.py. Pointer targets come from original font/pixel
// oracles, independently of the actual OCR boxes used by the production layer.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
const directory = path.resolve("qa/ocr-geometry");
function distance(a, b) {
  a = a.replace(/\s/g, "").toLowerCase();
  b = b.replace(/\s/g, "").toLowerCase();
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] !== b[j])),
      );
    row = next;
  }
  return row[b.length];
}
(async () => {
  const browser = await { chromium, webkit }[engine].launch();
  let cases = 0;
  try {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 1000 },
      deviceScaleFactor: 2,
    });
    await page.route(base + "/actual-scan-check.html", (r) =>
      r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/layout.css"><div id="fixture" class="pdf-page" style="position:relative;margin:24px;width:600px"><img id="pixels" style="width:100%;user-select:none;pointer-events:none"><div class="textLayer" id="ocr"></div></div>',
      }),
    );
    await page.goto(base + "/actual-scan-check.html");
    const samples = fs
      .readdirSync(directory)
      .filter((n) => !n.startsWith(".") && n.endsWith("-oracle.json"));
    for (const sample of samples) {
      const name = sample.replace("-oracle.json", ""),
        oracle = JSON.parse(fs.readFileSync(path.join(directory, sample))),
        data = JSON.parse(
          fs.readFileSync(path.join(directory, name + ".json")),
        );
      if (oracle.qualityOnly) continue;
      const bitmap =
        "data:image/png;base64," +
        fs.readFileSync(path.join(directory, name + ".png")).toString("base64");
      await page.evaluate(
        async ({ data, oracle, bitmap }) => {
          const { renderOcrLayer, paintOcrSelection } = await import(
            "/ui/ocr-layer.mjs"
          );
          const root = document.querySelector("#fixture"),
            layer = document.querySelector("#ocr");
          root.style.height = (600 * data.height) / data.width + "px";
          document.querySelector("#pixels").src = bitmap;
          renderOcrLayer(
            layer,
            data,
            { width: 600, height: (600 * data.height) / data.width },
            oracle.language,
          );
          document.onselectionchange = () =>
            paintOcrSelection(root, getSelection());
          getSelection().removeAllRanges();
        },
        { data, oracle, bitmap },
      );
      const box = await page.locator("#fixture").boundingBox();
      const point = (row, offset) => ({
        x: box.x + row.positions[offset] * box.width,
        y: box.y + ((row.bbox[1] + row.bbox[3]) / 2) * box.height,
      });
      if (!oracle.lines.length) {
        assert.equal(await page.locator("#ocr span").count(), 0);
        cases++;
        continue;
      }
      const groups = name.includes("columns")
        ? [oracle.lines.slice(0, 3), oracle.lines.slice(3)]
        : [oracle.lines];
      for (const group of groups)
        for (const reverse of [false, true]) {
          for (const multiline of [false, true]) {
            const first = group[0],
              last = multiline ? group.at(-1) : first;
            const start = point(first, 6),
              end = point(
                last,
                multiline
                  ? last.text.length - 3
                  : Math.min(first.text.length - 1, 22),
              );
            await page.mouse.click(box.x + 2, box.y + 2);
            await page.mouse.move(...Object.values(reverse ? end : start));
            await page.mouse.down();
            await page.mouse.move(...Object.values(reverse ? start : end), {
              steps: 12,
            });
            await page.mouse.up();
            const actual = await page.evaluate(() => getSelection().toString());
            const expected = multiline
              ? [
                  first.text.slice(6),
                  ...group.slice(1, -1).map((r) => r.text),
                  last.text.slice(0, -3),
                ].join(" ")
              : first.text.slice(6, Math.min(first.text.length - 1, 22));
            assert(
              distance(actual, expected) <= Math.max(3, expected.length * 0.15),
              JSON.stringify({
                engine,
                name,
                reverse,
                multiline,
                actual,
                expected,
              }),
            );
            cases++;
          }
        }
      if (name === "en-columns")
        await page.screenshot({ path: `qa/actual-scan-columns-${engine}.png` });
    }
    console.log(
      JSON.stringify({
        engine,
        samples: samples.length - 1,
        cases,
        actualOcr: true,
        independentPixelTargets: true,
        forwardAndReverse: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
