// Original short and mixed-size pages exercise more than three visible PDF pages.
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
function fixture(mixed) {
  return execFileSync(process.env.PYTHON || "python3", [
    "-c",
    `
import io,sys
from reportlab.pdfgen import canvas
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(600,90),invariant=1)
c.setTitle('Original viewport sample')
for n in range(30):
 c.setPageSize((600,${mixed === "extreme" ? "[70,1000,160,600][n%4]" : `360 if ${mixed ? "True" : "False"} and n%2 else 90`}))
 c.setFillColorRGB(.1,.3,.2);c.rect(20,10,560,70,fill=1)
 c.setFillColorRGB(1,1,1);c.drawString(40,40,'Original page '+str(n+1));c.showPage()
c.save();sys.stdout.buffer.write(b.getvalue())
`,
  ]);
}

async function checkNextScan(browser) {
  const scans = execFileSync(process.env.PYTHON || "python3", ["-c", `
import io,sys
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
output=io.BytesIO(); c=canvas.Canvas(output,pagesize=(600,800),invariant=1)
for number in range(1,4):
    image=Image.new('RGB',(600,800),'white')
    ImageDraw.Draw(image).text((60,36), 'Original scanned page '+str(number), fill='black', font=ImageFont.load_default(size=20))
    c.bookmarkPage(str(number)); c.addOutlineEntry('Scan '+str(number),str(number))
    c.drawImage(ImageReader(image),0,0,width=600,height=800); c.showPage()
c.save(); sys.stdout.buffer.write(output.getvalue())
`]);
  const response = await fetch(base + "/api/import?name=original-next-scan.pdf&parse=1", {
    method: "POST", body: scans,
  });
  assert(response.ok);
  const { book } = await response.json();
  await api("/api/state", {
    bookPrefs: { [book.id]: { pdfMode: "scroll", pdfZoom: 100, tocOpen: false } },
    positions: { [book.id]: { index: 1, top: 0, updatedAt: Date.now() } },
  });
  const p = await browser.newPage({ viewport: { width: 1100, height: 740 } });
  try {
    const requests = [];
    await p.route("**/api/ocr?*", route => {
      const page = Number(new URL(route.request().url()).searchParams.get("page"));
      requests.push(page);
      return route.fulfill({ json: { engine: "apple-vision", lines: [
        { text: `Original scanned page ${page}`, bbox: [.1, .045, .53, .075] },
      ] } });
    });
    await p.goto(base + "/#/read/" + book.id);
    const next = p.locator('.pdf-page[data-page="2"]');
    await next.locator('.textLayer span').waitFor({ state: 'attached', timeout: 8000 });
    assert.deepEqual(requests, [1, 2], "Mount only the current and next text layers while page two is offscreen");
    const view = p.locator("#reading-viewport");
    await view.evaluate(el => {
      const next = el.querySelector('[data-page="2"]').getBoundingClientRect();
      const bottom = el.getBoundingClientRect().bottom;
      if (next.top <= bottom) throw new Error("Page 2 should start below the viewport");
      el.scrollTop += next.top - bottom + 150;
    });
    assert.equal(await p.locator("#page-label").getAttribute("data-chapter"), "1");
    const line = await next.locator('.textLayer span').boundingBox();
    const bounds = await view.boundingBox();
    assert(line.y + line.height < bounds.y + bounds.height);
    await p.mouse.move(line.x + 1, line.y + line.height / 2);
    await p.mouse.down();
    await p.mouse.move(line.x + line.width - 1, line.y + line.height / 2, { steps: 8 });
    await p.mouse.up();
    assert.match(await p.evaluate(() => getSelection().toString()), /Original scanned page 2/);
    assert.equal(await p.locator("#page-label").getAttribute("data-chapter"), "1");
  } finally { await p.close(); }
}
(async () => {
  const state = await api("/api/state"),
    browser = await { chromium, webkit }[engine].launch();
  let cases = 0;
  try {
    await checkNextScan(browser);
    for (const mixed of [false, true, "extreme"]) {
      const r = await fetch(
        base +
          `/api/import?name=original-${mixed || "short"}-viewport.pdf&parse=0`,
        { method: "POST", body: fixture(mixed) },
      );
      const { book } = await r.json();
      assert(r.ok);
      await api("/api/state", {
        prefs: { pdfMode: "scroll", pdfZoom: 75 },
        positions: { [book.id]: { index: 1, top: 0, updatedAt: Date.now() } },
      });
      const p = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(base + "/#/read/" + book.id);
      await p.waitForFunction(
        () =>
          document.querySelector("#reading-viewport")?.getAttribute("aria-busy") === "false" &&
          !!document.querySelector(".pdf-bitmap")?.width,
      );
      async function allVisible() {
        await p.waitForFunction(() => {
          const view = document
            .querySelector("#reading-viewport")
            .getBoundingClientRect();
          const visible = [...document.querySelectorAll(".pdf-page")].filter((r) => {
            const b = r.getBoundingClientRect();
            return b.top < view.bottom && b.bottom > view.top;
          });
          return visible.length > 0 && visible.every(
              (r) =>
                r.dataset.rendered === "ready" &&
                r.querySelector("canvas")?.width,
            );
        });
      }
      await allVisible();
      const count = await p.evaluate(() => {
        const v = document
          .querySelector("#reading-viewport")
          .getBoundingClientRect();
        return [...document.querySelectorAll(".pdf-page")].filter((r) => {
          const b = r.getBoundingClientRect();
          return b.top < v.bottom && b.bottom > v.top;
        }).length;
      });
      if (!mixed)
        assert(
          count > 3,
          "The fixture must expose the old three-page assumption.",
        );
      for (const target of [10, 3, 21, 30, 1, 9, 18, 2, 22, 7, 15, 5, 24]) {
        await p.locator("#page-label").click();
        await p.locator("#page-jump-input").fill(String(target));
        await p.locator("#page-dialog button[type=submit]").click();
        await allVisible();
        await p.waitForTimeout(500);
        assert.equal(
          await p.locator("#page-label").getAttribute("data-chapter"),
          String(target),
          "Short or mixed pages must not skip the requested target.",
        );
        cases++;
      }
      await p.setViewportSize({ width: 1280, height: 1100 });
      await p.waitForTimeout(150);
      await allVisible();
      cases++;
      assert.deepEqual(errors, []);
      await p.close();
    }
    console.log(
      JSON.stringify({
        engine,
        cases,
        allVisiblePagesDrawn: true,
        shortPageJump: true,
        mixedSizeJump: true,
        resize: true,
        nextScanSelectableEarly: true,
      }),
    );
  } finally {
    await browser.close();
    await api("/api/state", {
      prefs: {
        pdfMode: state.prefs.pdfMode || "scroll",
        pdfZoom: state.prefs.pdfZoom || 100,
      },
    });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
