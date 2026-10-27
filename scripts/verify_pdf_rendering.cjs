// Run against an isolated test library. The default 529-page PDF is original artwork.
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
  const data = await r.json();
  assert(r.ok, data.error);
  return data;
}
function fixture() {
  return execFileSync(process.env.PYTHON || "python3", [
    "-c",
    `
import io,sys
from PIL import Image,ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
image=Image.new('RGB',(600,800),'white');d=ImageDraw.Draw(image)
for y in range(120,640,40):d.rectangle((60,y,510,y+12),fill=(25,50,38))
d.rectangle((60,60,260,88),fill=(25,50,38));d.text((60,730),'Original page rendering sample',fill='black')
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(600,800),invariant=1)
c.setTitle('Original long PDF sample');c.setAuthor('Page Between demo')
for i in range(529):c.drawImage(ImageReader(image),0,0,600,800);c.showPage()
c.save();sys.stdout.buffer.write(b.getvalue())
`,
  ]);
}
(async () => {
  const original = await api("/api/state");
  const book = process.env.PDF_RENDER_BOOK
    ? (await api("/api/library")).books.find(
        (b) => b.id === process.env.PDF_RENDER_BOOK,
      )
    : await (async () => {
        const r = await fetch(
          base + "/api/import?name=original-rendering.pdf&parse=0",
          { method: "POST", body: fixture() },
        );
        assert(r.ok);
        return (await r.json()).book;
      })();
  assert(book?.type === "pdf" && book.pages >= 80);
  await api("/api/state", {
    prefs: { pdfMode: "scroll", pdfZoom: 180, pdfTint: true },
    positions: { [book.id]: { index: 1, top: 0, updatedAt: Date.now() } },
  });
  const browser = await { chromium, webkit }[engine].launch();
  const failures = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
    });
    page.on("pageerror", (e) => failures.push(e.message));
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      window.failPdfBitmapOnce = true;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        if (
          window.failPdfBitmapOnce &&
          this.getAttribute("aria-label")?.startsWith("PDF 第")
        ) {
          window.failPdfBitmapOnce = false;
          throw Error("Controlled canvas outage");
        }
        return original.apply(this, args);
      };
    });
    await page.goto(base + "/#/read/" + book.id);
    await page.locator('.pdf-page[data-page="1"] .pdf-page-error').waitFor();
    assert.equal(
      await page
        .locator('.pdf-page[data-page="1"]')
        .getAttribute("data-rendered"),
      "error",
    );
    await page
      .locator('.pdf-page[data-page="1"] .pdf-page-error button')
      .click();
    const ready = async (index) => {
      await page.waitForFunction((index) => {
        const root = document.querySelector(`.pdf-page[data-page="${index}"]`);
        return (
          root?.dataset.rendered === "ready" &&
          root.getAttribute("aria-busy") === "false" &&
          root.querySelector("canvas")?.width
        );
      }, index);
      const info = await page.evaluate((index) => {
        const r = document.querySelector(`.pdf-page[data-page="${index}"]`),
          c = r.querySelector("canvas"),
          context = c.getContext("2d");
        const pixels = context.getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 64)
          if (pixels[i] < 190 && pixels[i + 3]) ink++;
        return {
          ink,
          area: c.width * c.height,
          filter: getComputedStyle(document.querySelector("#pdf-paper")).filter,
          pageFilter: getComputedStyle(c).filter,
        };
      }, index);
      assert(
        info.ink > 100,
        "A ready page must contain the original image pixels: " +
          JSON.stringify({ index, ...info }),
      );
      assert(
        info.area <= 8_000_000,
        "Large Retina backing stores must stay within the per-page budget.",
      );
      assert.equal(
        info.filter,
        "none",
        "Theme filters must not composite the entire continuous book.",
      );
      assert.notEqual(info.pageFilter, "none");
    };
    await ready(1);
    await page.locator("#toc-close").click();
    const jump = async (index) => {
      await page.evaluate((index) => {
        getSelection().removeAllRanges();
        document.querySelector("#reading-viewport").scrollTop =
          document.querySelector(`.pdf-page[data-page="${index}"]`).offsetTop;
      }, index);
      await ready(index);
    };
    for (const index of [27, 80, Math.min(420, book.pages), book.pages, 29])
      await jump(index);
    // Latest viewport wins even when earlier prefetches have already started.
    for (const index of [60, 11, 70, 2, 50, 29]) {
      await page.evaluate(
        (index) =>
          (document.querySelector("#reading-viewport").scrollTop =
            document.querySelector(
              `.pdf-page[data-page="${index}"]`,
            ).offsetTop),
        index,
      );
      await page.waitForTimeout(30);
    }
    await ready(29);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".pdf-page")].every(
        (r) => r.dataset.rendered !== "loading",
      ),
    );
    const buffers = await page.evaluate(() =>
      [...document.querySelectorAll(".pdf-page canvas")].map(
        (c) => c.width * c.height,
      ),
    );
    assert(
      buffers.length <= 8 && buffers.reduce((a, b) => a + b, 0) <= 24_000_000,
      "Recent page bitmaps must respect the bounded cache after rapid scrolling.",
    );
    const lose = async (kind) => {
      const before = await page.evaluate((kind) => {
        const r = document.querySelector('.pdf-page[data-page="29"]');
        window.previousPdfCanvas = r.querySelector("canvas");
        window.previousPdfText = r.querySelector(".textLayer");
        if (kind === "context")
          window.previousPdfCanvas.dispatchEvent(
            new Event("contextlost", { cancelable: true }),
          );
        else {
          window.previousPdfCanvas.width = 0;
          window.dispatchEvent(new Event("focus"));
        }
        return document.querySelector("#reading-viewport").scrollTop;
      }, kind);
      await page.waitForFunction(
        () =>
          document.querySelector('.pdf-page[data-page="29"] canvas') !==
          window.previousPdfCanvas,
      );
      await ready(29);
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector('.pdf-page[data-page="29"] .textLayer') ===
            window.previousPdfText,
        ),
        true,
        "Recovering a bitmap must retain the selection layer.",
      );
      assert(
        Math.abs(
          (await page
            .locator("#reading-viewport")
            .evaluate((n) => n.scrollTop)) - before,
        ) < 2,
        "Recovery must keep the reading position.",
      );
    };
    await lose("context");
    await lose("empty");
    await page.setViewportSize({ width: 1180, height: 840 });
    await ready(29);
    await page.waitForTimeout(200);
    await ready(29);
    // At a normal reading scale, recent pages can stay cached within 24 MP.
    await page.close();
    await api("/api/state", { prefs: { pdfZoom: 100 } });
    const cachedPage = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    cachedPage.on("pageerror", (e) => failures.push(e.message));
    await cachedPage.goto(base + "/#/read/" + book.id);
    await cachedPage.waitForFunction(
      () =>
        document.querySelector(".pdf-page canvas") &&
        !document.querySelector("#ai-open").disabled,
    );
    const jumpCached = async (index) => {
      await cachedPage.evaluate((index) => {
        document.querySelector("#reading-viewport").scrollTop =
          document.querySelector(`.pdf-page[data-page="${index}"]`).offsetTop;
      }, index);
      await cachedPage.waitForFunction(
        (index) =>
          document.querySelector(`.pdf-page[data-page="${index}"]`)?.dataset
            .rendered === "ready",
        index,
      );
    };
    await jumpCached(29);
    await cachedPage.evaluate(() => {
      window.cachedCanvas = document.querySelector(
        '.pdf-page[data-page="29"] canvas',
      );
      const proxy = document.querySelector(
        '.pdf-page[data-page="29"]',
      )._pageProxy;
      const proto = Object.getPrototypeOf(proxy),
        getText = proto.getTextContent,
        render = proto.render;
      proto.getTextContent = function (...args) {
        if (this.pageNumber === 50)
          return new Promise((resolve) => {
            window.resumePdfText = () => resolve(getText.apply(this, args));
          });
        return getText.apply(this, args);
      };
      proto.render = function (...args) {
        const task = render.apply(this, args);
        if (this.pageNumber !== 70 || window.delayedPdfPaint) return task;
        window.delayedPdfPaint = true;
        let cancel;
        return {
          _internalRenderTask: task._internalRenderTask,
          set onContinue(value) { task.onContinue = value; },
          get onContinue() { return task.onContinue; },
          promise: new Promise((resolve, reject) => {
            cancel = reject;
            task.promise.catch(reject);
            window.resumeOldPdfPaint = () => task.promise.then(resolve, reject);
          }),
          cancel() {
            window.obsoletePdfPaintCancelled = true;
            task.cancel();
            const error = new Error("Cancelled obsolete prefetch");
            error.name = "RenderingCancelledException";
            cancel(error);
          },
        };
      };
    });
    await jumpCached(32);
    await jumpCached(29);
    assert(
      await cachedPage.evaluate(
        () =>
          document.querySelector('.pdf-page[data-page="29"] canvas') ===
          window.cachedCanvas,
      ),
      "A recent page should reuse its finished bitmap.",
    );
    await jumpCached(50);
    await cachedPage.waitForFunction(
      () => typeof window.resumePdfText === "function",
    );
    await jumpCached(51);
    assert(
      await cachedPage.evaluate(
        () => !document.querySelector('.pdf-page[data-page="50"]')._textReady,
      ),
      "A slow text layer must not block the following page image.",
    );
    await cachedPage.evaluate(() => window.resumePdfText());
    await cachedPage.waitForFunction(
      () => document.querySelector('.pdf-page[data-page="50"]')._textReady,
    );
    await cachedPage.evaluate(() => {
      document.querySelector("#reading-viewport").scrollTop =
        document.querySelector('.pdf-page[data-page="70"]').offsetTop;
    });
    await cachedPage.waitForFunction(() => window.delayedPdfPaint);
    await jumpCached(100);
    assert(
      await cachedPage.evaluate(() => window.obsoletePdfPaintCancelled),
      "An obsolete paint must yield to the new reading position.",
    );
    await jumpCached(70);
    assert(
      await cachedPage.evaluate(
        () =>
          document.querySelector('.pdf-page[data-page="70"] canvas')?.width > 0,
      ),
      "Cancelled pages must remain retryable when revisited.",
    );
    assert.deepEqual(failures, []);
    console.log(
      JSON.stringify({
        engine,
        longBookPages: book.pages,
        canvasFailureRetry: true,
        rapidScroll: true,
        memoryBound: true,
        contextRecovery: true,
        emptyCanvasRecovery: true,
        selectionLayerRetained: true,
        resize: true,
        syntheticContextLoss: true,
        recentBitmapReused: true,
        slowTextDoesNotBlockImage: true,
        obsoletePaintCancelledAndRevisited: true,
      }),
    );
  } finally {
    await browser.close();
    await api("/api/state", {
      prefs: {
        pdfMode: original.prefs.pdfMode || "scroll",
        pdfZoom: original.prefs.pdfZoom || 100,
        pdfTint: original.prefs.pdfTint !== false,
      },
    });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
