// Original overlapping OCR lines. Pixel checks distinguish one fill from stacked alpha.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["chromium", "webkit"].includes(engine));
(async () => {
  const browser = await { chromium, webkit }[engine].launch();
  let cases = 0;
  try {
    for (const density of [1, 2]) {
      const p = await browser.newPage({
        viewport: { width: 800, height: 500 },
        deviceScaleFactor: density,
      });
      await p.route(base + "/selection-color-check.html", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/layout.css"></head><body data-theme="paper"><div id="fixture" class="pdf-page" style="width:400px;height:220px;margin:40px;background:white"><div id="ocr" class="textLayer"></div></div></body></html>',
        }),
      );
      await p.goto(base + "/selection-color-check.html");
      await p.evaluate(async () => {
        const { renderOcrLayer, paintOcrSelection } = await import(
          "/ui/ocr-layer.mjs"
        );
        const { canonicalSelection } = await import("/ui/pdf-selection.mjs");
        const root = document.querySelector("#fixture"),
          layer = document.querySelector("#ocr");
        renderOcrLayer(
          layer,
          {
            engine: "apple-vision",
            lines: [
              { text: "第一行用于检查高亮颜色", bbox: [0.1, 0.15, 0.9, 0.45] },
              { text: "第二行与上一行有重叠", bbox: [0.1, 0.4, 0.9, 0.7] },
            ],
          },
          { width: 400, height: 220 },
          "zh",
        );
        const nodes = layer.querySelectorAll("span"),
          range = document.createRange();
        range.setStart(nodes[0].firstChild, 0);
        range.setEnd(nodes[1].firstChild, nodes[1].textContent.length);
        getSelection().addRange(range);
        window.beforeSelectionColor = {
          raw: getSelection().toString(),
          copy: canonicalSelection(range, root),
        };
        paintOcrSelection(root, getSelection());
        window.checkSelectionContent = () => ({
          raw: getSelection().toString(),
          copy: canonicalSelection(getSelection().getRangeAt(0), root),
        });
      });
      for (const theme of ["paper", "sage", "blue", "night"]) {
        const info = await p.evaluate((theme) => {
          document.body.dataset.theme = theme;
          const svg = document.querySelector(".ocr-selection-highlights"),
            path = svg.firstElementChild;
          const bands = [
            ...path
              .getAttribute("d")
              .matchAll(
                /M([\d.e+-]+),([\d.e+-]+)H([\d.e+-]+)V([\d.e+-]+)H[\d.e+-]+Z/g,
              ),
          ].map((m) => ({
            left: +m[1],
            top: +m[2],
            right: +m[3],
            bottom: +m[4],
          }));
          const [a, b] = bands,
            x = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
          return {
            namespace: svg.namespaceURI,
            paths: svg.children.length,
            fill: getComputedStyle(path).fill,
            overlap: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
            points: [
              [x, (a.top + Math.min(a.bottom, b.top)) / 2],
              [x, (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2],
            ],
            before: window.beforeSelectionColor,
            after: window.checkSelectionContent(),
          };
        }, theme);
        assert.equal(info.namespace, "http://www.w3.org/2000/svg");
        assert.equal(info.paths, 1);
        assert(info.overlap > 4);
        assert.deepEqual(info.after, info.before);
        const png = await p.locator("#fixture").screenshot();
        const colors = JSON.parse(
          execFileSync(
            process.env.PYTHON || "python3",
            [
              "-c",
              `import io,json,sys
from PIL import Image
image=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGBA')
points=json.loads(sys.argv[1]);sx=image.width/400;sy=image.height/220
print(json.dumps([image.getpixel((round(x*sx),round(y*sy))) for x,y in points]))`,
              JSON.stringify(info.points),
            ],
            { input: png },
          ).toString(),
        );
        assert(
          colors[0].some((v) => v < 245),
          "Highlight must actually be visible",
        );
        assert(
          colors[0].every((v, i) => Math.abs(v - colors[1][i]) <= 1),
          JSON.stringify({ engine, density, theme, colors }),
        );
        cases++;
      }
      await p.evaluate(async () => {
        getSelection().removeAllRanges();
        const { paintOcrSelection } = await import("/ui/ocr-layer.mjs");
        paintOcrSelection(document.querySelector("#fixture"), getSelection());
      });
      assert.equal(
        await p.locator(".ocr-selection-highlights path").getAttribute("d"),
        "",
      );
      await p.close();
    }
    console.log(
      JSON.stringify({
        engine,
        cases,
        overlapMatchesSingleFill: true,
        copyUnchanged: true,
        clearSelection: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
