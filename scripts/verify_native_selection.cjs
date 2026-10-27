// Original PDF fixture: dense lines, small capitals, separate columns and rotated text.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["chromium", "webkit"].includes(engine));
async function api(path, body) {
  const r = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const d = await r.json();
  assert(r.ok, d.error);
  return d;
}
const fixture = execFileSync(process.env.PYTHON || "python3", [
  "-c",
  `
import io
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(600,640),invariant=1)
c.setTitle('Original selection sample');c.setAuthor('Page Between demo')
c.setFont('Times-Roman',12)
c.drawString(48,560,'A quiet line makes precise selection easy.')
x=48;c.drawString(x,546.8,'We introduce A');x+=stringWidth('We introduce A','Times-Roman',12)
c.setFont('Times-Roman',9.6);c.drawString(x,546.8,'LIGNMENT');x+=stringWidth('LIGNMENT','Times-Roman',9.6)
c.setFont('Times-Roman',12);c.drawString(x,546.8,' for careful reading.')
c.drawString(48,533.6,'The following line keeps its own breathing space.')
c.setFont('Helvetica',9.96)
c.drawString(48,505,'A long sans-serif line must end at its PDF advance, with no extra highlight.')
c.setFont('Times-Roman',12)
c.drawString(48,480,'Left column remains separate.')
c.drawString(330,480,'Right column remains separate.')
c.saveState();c.translate(80,120);c.rotate(90);c.drawString(0,0,'Rotated selection remains readable.');c.restoreState()
c.save();import sys;sys.stdout.buffer.write(b.getvalue())
`,
]);
(async () => {
  const original = await api("/api/state");
  const r = await fetch(
    base + "/api/import?name=original-selection.pdf&parse=0",
    { method: "POST", body: fixture },
  );
  const { book } = await r.json();
  assert(r.ok && book.type === "pdf");
  const browser = await { chromium, webkit }[engine].launch();
  const failures = [];
  let cases = 0;
  try {
    for (const density of [1, 2])
      for (const zoom of [75, 100, 140]) {
        await api("/api/state", {
          prefs: { pdfMode: "scroll", pdfZoom: zoom },
          positions: { [book.id]: { index: 1, top: 0, updatedAt: Date.now() } },
        });
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: density,
        });
        page.on("pageerror", (e) => failures.push(e.message));
        await page.goto(base + "/#/read/" + book.id);
        await page.waitForFunction(
          () =>
            document
              .querySelector("#reading-viewport")
              ?.getAttribute("aria-busy") === "false" &&
            !document.querySelector("#ai-open").disabled &&
            document.querySelector(".textLayer[data-pdf-native]"),
        );
        await page.locator("#toc-close").click();
        const initial = await page.evaluate(async () => {
          const root = document.querySelector('.pdf-page[data-page="1"]'),
            layer = root.querySelector(".textLayer");
          const spans = [...layer.querySelectorAll("span")];
          const first = spans.find((s) => s.textContent.startsWith("A quiet"));
          const content = await root._pageProxy.getTextContent();
          const widths = ["A quiet", "A long sans-serif"].map((prefix) => {
            const node = spans.find((s) => s.textContent.startsWith(prefix));
            const item = content.items.find(
              (item) => item.str === node.textContent,
            );
            return {
              actual: node.getBoundingClientRect().width,
              expected: item.width * root._viewport.scale,
            };
          });
          return {
            font: parseFloat(getComputedStyle(first).fontSize),
            expected: 12 * root._viewport.scale,
            transform: getComputedStyle(first).transform,
            widths,
            language: layer.lang,
            pdfLanguage: content.lang || "",
          };
        });
        assert(
          Math.abs(initial.font - initial.expected) < 0.1,
          "PDF glyph sizing must consume the PDF.js scale, not inherit the UI font.",
        );
        assert.notEqual(initial.transform, "none");
        assert.equal(initial.language, initial.pdfLanguage);
        for (const { actual, expected } of initial.widths)
          assert(
            Math.abs(actual - expected) < 0.5,
            "Native selection must end at the PDF advance, across language-dependent fallback fonts: " +
              JSON.stringify(initial.widths),
          );
        const select = async (kind) => {
          const raw = await page.evaluate(async (kind) => {
            const layer = document.querySelector(".textLayer[data-pdf-native]"),
              spans = [...layer.querySelectorAll("span")];
            const first = spans.find((s) =>
                s.textContent.startsWith("A quiet"),
              ),
              last = spans.find((s) =>
                s.textContent.startsWith("The following"),
              );
            const left = spans.find((s) =>
                s.textContent.startsWith("Left column"),
              ),
              right = spans.find((s) =>
                s.textContent.startsWith("Right column"),
              );
            const rotated = spans.find((s) =>
              s.textContent.startsWith("Rotated selection"),
            );
            const selection = getSelection();
            selection.removeAllRanges();
            if (kind === "word") {
              const offset = first.textContent.indexOf("quiet");
              selection.setBaseAndExtent(
                first.firstChild,
                offset,
                first.firstChild,
                offset + 5,
              );
            } else if (kind === "reverse")
              selection.setBaseAndExtent(
                last.firstChild,
                last.textContent.length,
                first.firstChild,
                0,
              );
            else if (kind === "columns")
              selection.setBaseAndExtent(
                left.firstChild,
                0,
                right.firstChild,
                right.textContent.length,
              );
            else if (kind === "rotated")
              selection.setBaseAndExtent(
                rotated.firstChild,
                0,
                rotated.firstChild,
                rotated.textContent.length,
              );
            else
              selection.setBaseAndExtent(
                first.firstChild,
                0,
                last.firstChild,
                last.textContent.length,
              );
            const { canonicalSelection } = await import(
              "/ui/pdf-selection.mjs"
            );
            return {
              text: selection.toString(),
              copy: canonicalSelection(
                selection.getRangeAt(0),
                layer.parentElement,
              ),
            };
          }, kind);
          await page.waitForFunction(
            () =>
              !!document
                .querySelector(".pdf-selection-highlights path")
                ?.getAttribute("d"),
          );
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          const info = await page.evaluate(async () => {
            const root = document.querySelector('.pdf-page[data-page="1"]'),
              path = root.querySelector(".pdf-selection-highlights path");
            const { canonicalSelection } = await import(
              "/ui/pdf-selection.mjs"
            );
            return {
              text: getSelection().toString(),
              copy: canonicalSelection(getSelection().getRangeAt(0), root),
              d: path.getAttribute("d"),
              stroke: getComputedStyle(path).stroke,
              native: getComputedStyle(
                root.querySelector(".textLayer span"),
                "::selection",
              ).backgroundColor,
            };
          });
          assert.equal(
            info.text,
            raw.text,
            "Painting must leave the native range unchanged.",
          );
          assert.equal(
            info.copy,
            raw.copy,
            "Painting must preserve the original copy pipeline.",
          );
          assert.equal(info.stroke, "none");
          assert.equal(
            info.native,
            "rgba(0, 0, 0, 0)",
            "The native highlight must not paint on top of the custom selection.",
          );
          const rects = [
            ...info.d.matchAll(
              /M([\d.e+-]+),([\d.e+-]+)H([\d.e+-]+)V([\d.e+-]+)H[\d.e+-]+Z/g,
            ),
          ].map((m) => ({
            left: +m[1],
            top: +m[2],
            right: +m[3],
            bottom: +m[4],
          }));
          if (["lines", "reverse"].includes(kind)) {
            assert.equal(
              rects.length,
              3,
              "Small capitals must merge with their own line.",
            );
            for (let i = 1; i < rects.length; i++)
              assert(
                rects[i].top > rects[i - 1].bottom + 1,
                "Dense lines need a visible gap.",
              );
          }
          if (kind === "columns")
            assert.equal(
              rects.length,
              2,
              "Selecting both columns must leave the gutter clear.",
            );
          if (kind === "word") {
            assert.equal(raw.text, "quiet");
            assert.equal(info.copy, "quiet");
          }
          assert(rects.length > 0);
          cases++;
        };
        for (const kind of ["word", "lines", "reverse", "columns", "rotated"])
          await select(kind);
        // Real pointer selection uses the unchanged browser range and corrected glyph sizing.
        await page.evaluate(() => {
          getSelection().removeAllRanges();
          document.querySelector("#reading-viewport").scrollTop = 0;
        });
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(resolve)),
        );
        const points = await page.evaluate(() => {
          const n = [...document.querySelectorAll(".textLayer span")].find(
            (s) => s.textContent.startsWith("A quiet"),
          ).firstChild;
          const start = n.textContent.indexOf("quiet"),
            range = document.createRange();
          range.setStart(n, start);
          range.setEnd(n, start + 1);
          const a = range.getBoundingClientRect();
          range.setStart(n, start + 4);
          range.setEnd(n, start + 5);
          const b = range.getBoundingClientRect();
          return {
            a: [a.left + a.width * 0.15, a.top + a.height * 0.5],
            b: [b.left + b.width * 0.85, b.top + b.height * 0.5],
          };
        });
        for (const reverse of [false, true]) {
          await page.evaluate(() => getSelection().removeAllRanges());
          await page.waitForFunction(
            () => document.querySelector("#selection-toolbar").hidden,
          );
          await page.mouse.move(...(reverse ? points.b : points.a));
          await page.mouse.down();
          await page.mouse.move(...(reverse ? points.a : points.b), {
            steps: 12,
          });
          await page.mouse.up();
          const selected = await page.evaluate(() => getSelection().toString());
          if (selected !== "quiet")
            await page.screenshot({
              path: `qa/native-selection-pointer-${engine}-${density}-${zoom}-${reverse}.png`,
            });
          assert.equal(
            selected,
            "quiet",
            JSON.stringify({ engine, density, zoom, reverse, points }),
          );
          cases++;
        }
        if (
          density === 2 &&
          zoom === 100 &&
          process.env.NATIVE_SELECTION_SCREENSHOT
        ) {
          await select("lines");
          await page
            .locator('.pdf-page[data-page="1"]')
            .screenshot({ path: process.env.NATIVE_SELECTION_SCREENSHOT });
        }
        if (density === 2 && zoom === 100) {
          await select("lines");
          const before = await page.evaluate(() => {
            const root = document.querySelector('.pdf-page[data-page="1"]');
            window.nativePreviousCanvas = root.querySelector("canvas");
            window.nativePreviousText = root.querySelector(".textLayer");
            const text = getSelection().toString();
            window.nativePreviousCanvas.dispatchEvent(
              new Event("contextlost", { cancelable: true }),
            );
            return text;
          });
          await page.waitForFunction(
            () =>
              document.querySelector('.pdf-page[data-page="1"] canvas') !==
              window.nativePreviousCanvas,
          );
          assert.equal(
            await page.evaluate(() => getSelection().toString()),
            before,
            "Bitmap recovery must retain the live native range.",
          );
          assert.equal(
            await page.evaluate(
              () =>
                document.querySelector(
                  '.pdf-page[data-page="1"] .textLayer',
                ) === window.nativePreviousText,
            ),
            true,
          );
          cases++;
        }
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.waitForFunction(() =>
          [
            ...document.querySelectorAll(".pdf-selection-highlights path"),
          ].every((path) => !path.getAttribute("d")),
        );
        await page.close();
      }
    assert.deepEqual(failures, []);
    console.log(
      engine,
      cases,
      "native PDF selection cases passed: sizing, gaps, small capitals, separate columns, rotation, pointer selection and copy",
    );
  } finally {
    await browser.close();
    await api("/api/state", {
      prefs: {
        pdfMode: original.prefs.pdfMode || "scroll",
        pdfZoom: original.prefs.pdfZoom || 100,
      },
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
