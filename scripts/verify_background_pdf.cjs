// Offscreen page rendering must work without animation frames, including cancel/retry.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["chromium", "webkit"].includes(engine));
const pdf = execFileSync(process.env.PYTHON || "python3", [
  "-c",
  `
import io,sys
from reportlab.pdfgen import canvas
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(600,800),invariant=1)
for i in range(3):
 c.setFillColorRGB(.1,.3,.2);c.rect(40,500,400,100,fill=1);c.drawString(40,460,'Original offscreen rendering sample');c.showPage()
c.save();sys.stdout.buffer.write(b.getvalue())
`,
]);
(async () => {
  const browser = await { chromium, webkit }[engine].launch();
  try {
    const page = await browser.newPage();
    await page.route(base + "/background-rendering.pdf", (route) =>
      route.fulfill({ contentType: "application/pdf", body: pdf }),
    );
    await page.route(base + "/background-rendering.html", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><div>Original rendering test</div>",
      }),
    );
    await page.goto(base + "/background-rendering.html");
    const result = await page.evaluate(async () => {
      const pdfjs = await import("/assets/vendor/pdf.mjs"),
        { renderPdfBitmap } = await import("/ui/pdf-render.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/assets/vendor/pdf.worker.mjs";
      let requestedFrames = 0;
      window.requestAnimationFrame = () => {
        requestedFrames++;
        return 1;
      };
      const pdf = await pdfjs.getDocument("/background-rendering.pdf").promise;
      const render = async (index, cancel = false) => {
        const page = await pdf.getPage(index),
          viewport = page.getViewport({ scale: 1.5 }),
          canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d"),
          task = renderPdfBitmap(page, { canvasContext: context, viewport });
        if (cancel) task.cancel();
        try {
          await task.promise;
        } catch (error) {
          canvas.width = canvas.height = 0;
          return { cancelled: error.name === "RenderingCancelledException" };
        }
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 64)
          if (pixels[i] < 150 && pixels[i + 3]) ink++;
        canvas.width = canvas.height = 0;
        return { ink };
      };
      const first = await render(1),
        cancelled = await render(2, true),
        retried = await render(2),
        last = await render(3);
      await pdf.destroy();
      return { first, cancelled, retried, last, requestedFrames };
    });
    assert.equal(result.requestedFrames, 0);
    assert(result.cancelled.cancelled);
    assert(
      [result.first, result.retried, result.last].every(
        (page) => page.ink > 100,
      ),
    );
    console.log(
      JSON.stringify({
        engine,
        zeroAnimationFrames: true,
        pages: 3,
        cancelAndRetry: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
