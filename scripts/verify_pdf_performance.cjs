// Controlled same-document comparison; timings are observations, not a desktop FPS claim.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { webkit, chromium } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
const baseline = process.env.PDF_BASELINE === "1";
const source = baseline
  ? execFileSync("git", ["show", "09ce0dd:app-v2.mjs"], { encoding: "utf8" })
  : null;
const bytes = execFileSync(process.env.PYTHON || "python3", [
  "-c",
  `
import io,sys
from reportlab.pdfgen import canvas
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(600,800),invariant=1)
for n in range(45):
 c.setFillColorRGB(.12,.3,.2);c.rect(40,600,500,100,fill=1)
 c.setFont('Helvetica',13)
 for y in range(80,580,22):c.drawString(40,y,'Original book rendering sample page '+str(n+1))
 c.showPage()
c.save();sys.stdout.buffer.write(b.getvalue())
`,
]);
(async () => {
  const response = await fetch(
    base + "/api/import?name=original-performance.pdf&parse=0",
    { method: "POST", body: bytes },
  );
  const { book } = await response.json();
  assert(response.ok);
  await fetch(base + "/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prefs: { pdfMode: "scroll", pdfZoomMode: "custom", pdfZoom: 100 },
      positions: { [book.id]: { index: 1, pdfY: 0, updatedAt: Date.now() } },
    }),
  });
  const browser = await { webkit, chromium }[engine].launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/app-v2.mjs*", async (route) => {
      const body = source || (await (await route.fetch()).text());
      await route.fulfill({
        contentType: "text/javascript",
        body:
          body +
          `\n
window.pdfTextRequests=[];window.pdfBitmapRequests=[];
const probeText=preparePdfText;preparePdfText=(...args)=>{window.pdfTextRequests.push(args[4]);return probeText(...args)};
const probePaint=paintPdfPage;paintPdfPage=async (...args)=>{window.pdfBitmapRequests.push(args[0]);while(window.holdPdfPaint)await new Promise(r=>setTimeout(r,20));return probePaint(...args)};
window.pdfProbe=()=>({position:location,cache:typeof pdfPreviews==='undefined'?null:{pages:pdfPreviews.pages.size,keys:[...pdfPreviews.pages.keys()],pixels:[...pdfPreviews.pages.values()].reduce((s,c)=>s+c.width*c.height,0)}});
`,
      });
    });
    await page.goto(base + "/#/read/" + book.id);
    const ready = (index) =>
      page.waitForFunction(
        (index) =>
          document.querySelector('.pdf-page[data-page="' + index + '"]')
            ?.dataset.rendered === "ready" &&
          !document.querySelector("#ai-open").disabled,
        index,
      );
    await ready(1);
    await page.waitForTimeout(500);
    const initial = await page.evaluate(() => [...window.pdfTextRequests]);
    if (!baseline)
      assert.deepEqual(
        initial,
        [1],
        "Neighbour bitmap prefetch must not eagerly extract offscreen text.",
      );
    if (!baseline) {
      const immediate = await page.evaluate(() => {
        document
          .querySelector('.pdf-page[data-page="2"]')
          .dispatchEvent(new PointerEvent("pointerenter"));
        return window.pdfTextRequests.includes(2);
      });
      assert(immediate, "Pointer intent must bypass the visibility delay.");
      await page.waitForTimeout(100);
    }
    await page.evaluate(() => {
      window.pdfTextRequests = [];
    });
    for (const index of [5, 9, 13, 17, 21, 25]) {
      await page.evaluate((index) => {
        document.querySelector("#reading-viewport").scrollTop =
          document.querySelector(
            '.pdf-page[data-page="' + index + '"]',
          ).offsetTop;
      }, index);
      await page.waitForTimeout(55);
    }
    await ready(25);
    await page.waitForTimeout(500);
    const passed = await page.evaluate(() => [...window.pdfTextRequests]);
    if (!baseline)
      assert(
        passed.every((n) => n >= 24 && n <= 26),
        "Fast-pass pages must not queue text extraction: " + passed,
      );
    const before = await page.evaluate(() => ({
      y: document.querySelector("#reading-viewport").scrollTop,
      pdfY:
        document.querySelector("#reading-viewport").scrollTop -
        document.querySelector('.pdf-page[data-page="25"]').offsetTop,
    }));
    await page.evaluate(() => {
      window.holdPdfPaint = true;
    });
    await page.locator('#reader-zoom [data-zoom="in"]').click();
    await page.waitForTimeout(250);
    const waiting = await page.evaluate(() => {
      const root = document.querySelector('.pdf-page[data-page="25"]'),
        c = root.querySelector("canvas");
      let ink = 0;
      if (c?.width) {
        const data = c
          .getContext("2d")
          .getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < data.length; i += 64) if (data[i] < 180) ink++;
      }
      return {
        preview: !!root.querySelector(".pdf-preview"),
        ink,
        loader: !document.querySelector("#reader-loading").hidden,
        previews: [...document.querySelectorAll(".pdf-preview")].map(
          (c) => c.parentElement.dataset.page,
        ),
        ...window.pdfProbe(),
      };
    });
    if (!baseline) {
      assert(
        waiting.preview && waiting.ink > 100 && !waiting.loader,
        JSON.stringify(waiting),
      );
    }
    await page.evaluate(() => {
      window.holdPdfPaint = false;
    });
    await ready(25);
    await page.waitForTimeout(300);
    const final = await page.evaluate(() => ({
      preview: !!document.querySelector(
        '.pdf-page[data-page="25"] .pdf-preview',
      ),
      full: !!document.querySelector('.pdf-page[data-page="25"] .pdf-bitmap'),
      shadow: getComputedStyle(document.querySelector(".pdf-page")).boxShadow,
      ...window.pdfProbe(),
    }));
    if (!baseline) {
      assert(!final.preview && final.full);
      assert(final.cache.pages <= 12 && final.cache.pixels <= 3000000);
      assert.equal(final.shadow, "none");
    }
    if (!baseline)
      await page.evaluate(async () => {
        const { PdfPreviewCache } = await import("/ui/pdf-preview.mjs");
        const cache = new PdfPreviewCache({ limit: 2, pixels: 250000 }),
          source = document.querySelector(".pdf-bitmap"),
          firstDocument = {};
        cache.use(firstDocument);
        cache.remember(1, source);
        cache.remember(2, source);
        const retired = cache.pages.get(1);
        cache.remember(3, source);
        if (cache.pages.size !== 2 || retired.width !== 0)
          throw Error("Preview eviction did not release its backing store");
        cache.use(firstDocument);
        if (cache.pages.size !== 2)
          throw Error("Same document discarded useful previews");
        const kept = [...cache.pages.values()];
        cache.use({});
        if (cache.pages.size || kept.some((c) => c.width || c.height))
          throw Error("Switching books retained the previous book preview");
      });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        baseline,
        initialTextPages: initial,
        fastPassTextPages: passed,
        redraw: waiting,
        final,
        before,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
