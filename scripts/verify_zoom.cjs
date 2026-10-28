// Use an isolated --demo server; this changes reading preferences and positions.
const assert = require("node:assert/strict");
const { webkit, chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
async function api(path, body) {
  const r = await fetch(
    base + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  assert(r.ok, data.error);
  return data;
}
(async () => {
  const old = await api("/api/state"),
    browser = await { webkit, chromium }[engine].launch();
  let checks = 0;
  try {
    await api("/api/state", {
      prefs: {
        fontSize: 21,
        palmScale: 1,
        pdfZoom: 100,
        pdfZoomMode: "custom",
        pdfMode: "scroll",
        textMode: "pages",
        palmMode: "pages",
      },
      positions: {
        "demo-c": { index: 2, pdfY: 0.3, updatedAt: Date.now() },
        "demo-a": { index: 1, page: 0, updatedAt: Date.now() },
        "demo-b": { index: 1, page: 0, updatedAt: Date.now() },
      },
    });
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(12000);
    const ready = () =>
      page.waitForFunction(
        () =>
          document.body.dataset.view === "reader" &&
          document
            .querySelector("#reading-viewport")
            .getAttribute("aria-busy") === "false" &&
          !document.querySelector("#ai-open").disabled,
      );
    const set = async (value, root = "#reader-zoom") => {
      await page.locator(root + " input").fill(value + "%");
      await page.locator(root + " input").press("Enter");
      await ready();
      await page.waitForFunction(
        ({ value, root }) =>
          document.querySelector(root + " input").value === value + "%" &&
          !document.querySelector(root + " input").disabled,
        { value, root },
      );
    };
    const width = () =>
      page.locator('.pdf-page[data-page="2"]').evaluate((n) => n.offsetWidth);
    await page.goto(base + "/#/read/demo-c");
    await ready();
    const originalWidth = await width(),
      barHeight = await page
        .locator("#reader-bar")
        .evaluate((n) => n.offsetHeight);
    await set(110);
    assert(Math.abs((await width()) / originalWidth - 1.1) < 0.005);
    checks++;
    await page.locator('#reader-zoom [data-zoom="in"]').click();
    await ready();
    assert.equal(await page.locator("#reader-zoom input").inputValue(), "125%");
    checks++;
    await page.locator('#reader-zoom [data-zoom="out"]').click();
    await ready();
    assert.equal(await page.locator("#reader-zoom input").inputValue(), "110%");
    checks++;
    await page.locator("#reading-viewport").focus();
    await page.keyboard.press("Meta+0");
    await ready();
    assert.equal(await page.locator("#reader-zoom input").inputValue(), "100%");
    checks++;
    const readingBox = await page.locator("#reading-viewport").boundingBox();
    await page.mouse.move(
      readingBox.x + readingBox.width * 0.7,
      readingBox.y + 100,
    );
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForFunction(
      () => document.querySelector("#reader-zoom input").value === "110%",
    );
    await ready();
    checks++;
    await set(100);
    assert.equal(
      await page.locator("#reader-bar").evaluate((n) => n.offsetHeight),
      barHeight,
    );
    await page.locator("#reader-zoom select").selectOption("width");
    await ready();
    const fits = () =>
      page.evaluate(() => {
        let view = document.querySelector("#reading-viewport"),
          root = document.querySelector(".pdf-page"),
          style = getComputedStyle(view);
        return {
          width: root.offsetWidth,
          height: root.offsetHeight,
          availableWidth:
            view.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight),
          availableHeight:
            view.clientHeight -
            parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom),
        };
      });
    let fit = await fits();
    assert(Math.abs(fit.width - fit.availableWidth) < 2);
    checks++;
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForFunction(
      () => document.querySelector(".pdf-page").offsetWidth < 1100,
    );
    await ready();
    fit = await fits();
    assert(Math.abs(fit.width - fit.availableWidth) < 2);
    checks++;
    await page.locator("#reader-zoom select").selectOption("page");
    await ready();
    fit = await fits();
    assert(
      fit.width <= fit.availableWidth + 2 &&
        fit.height <= fit.availableHeight + 2,
    );
    checks++;
    await set(400);
    assert(
      await page
        .locator("#reading-viewport")
        .evaluate((n) => n.scrollWidth > n.clientWidth),
    );
    const edge = await page.evaluate(() => {
      let view = document.querySelector("#reading-viewport"),
        page = document.querySelector(".pdf-page");
      view.scrollLeft = 0;
      return (
        page.getBoundingClientRect().left - view.getBoundingClientRect().left
      );
    });
    assert(edge >= -1);
    checks++;
    const horizontalCenter = () =>
      page.evaluate(() => {
        const view = document.querySelector("#reading-viewport"),
          paper = document.querySelector("#pdf-paper").getBoundingClientRect();
        return (
          (view.getBoundingClientRect().left +
            view.clientWidth / 2 -
            paper.left) /
          paper.width
        );
      });
    await page.locator("#reading-viewport").evaluate((view) => {
      view.scrollLeft = (view.scrollWidth - view.clientWidth) / 2;
    });
    const centerBefore = await horizontalCenter();
    await set(300);
    assert(Math.abs((await horizontalCenter()) - centerBefore) < 0.005);
    checks++;
    await page.evaluate(() =>
      readerOpenTutorSource("demo-c", { index: 2, pdfY: 0.3 }),
    );
    await set(125);
    await page.waitForTimeout(3000);
    assert.equal(
      await page.locator("#page-label").getAttribute("data-chapter"),
      "2",
    );
    const saved = (await api("/api/state")).positions["demo-c"];
    assert(Math.abs(saved.pdfY - 0.3) < 0.025, JSON.stringify(saved));
    checks++;
    await page.reload();
    await ready();
    assert.equal(await page.locator("#reader-zoom input").inputValue(), "125%");
    checks++;
    const mixed = execFileSync(process.env.PYTHON || "python3", [
      "-c",
      `
import io,sys
from reportlab.pdfgen import canvas
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(600,800),invariant=1)
c.setTitle('Original zoom geometry');c.drawString(60,700,'Original portrait page');c.showPage()
c.setPageSize((900,600));c.drawString(60,500,'Original landscape page');c.showPage();c.save();sys.stdout.buffer.write(b.getvalue())
`,
    ]);
    const response = await fetch(
        base + "/api/import?name=original-zoom-geometry.pdf&parse=0",
        { method: "POST", body: mixed },
      ),
      imported = await response.json();
    assert(response.ok);
    await page.goto(base + "/?zoom-check=1#/read/" + imported.book.id);
    await ready();
    await set(100);
    assert.equal(
      await page
        .locator('.pdf-page[data-page="1"]')
        .evaluate((n) => n.offsetWidth),
      800,
    );
    assert.equal(
      await page
        .locator('.pdf-page[data-page="2"]')
        .evaluate((n) => n.offsetWidth),
      1200,
    );
    checks++;
    await page.evaluate(
      (book) => readerOpenTutorSource(book, { index: 2, pdfY: 0 }),
      imported.book.id,
    );
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.waitForTimeout(200);
    await ready();
    assert.equal(
      await page
        .locator('.pdf-page[data-page="1"]')
        .evaluate((n) => n.offsetWidth),
      800,
    );
    checks++;
    for (const [id, epub] of [
      ["demo-b", false],
      ["demo-a", true],
    ]) {
      await api("/api/state", { prefs: { fontSize: 21, textMode: "pages" } });
      await page.goto(base + "/#/read/" + id);
      await ready();
      await set(100);
      const font = () =>
        page.evaluate(
          (epub) =>
            parseFloat(
              getComputedStyle(
                epub
                  ? document.querySelector("#epub-frame").contentDocument.body
                  : document.querySelector("#chapter-body p"),
              ).fontSize,
            ),
          epub,
        );
      const before = await font();
      await set(150);
      assert.equal(
        await page
          .locator('#quick-settings [data-pref="fontSize"]')
          .inputValue(),
        "31.5",
      );
      assert(
        Math.abs((await font()) / before - 1.5) < 0.01,
        JSON.stringify({
          id,
          before,
          after: await font(),
          input: await page.locator("#reader-zoom input").inputValue(),
        }),
      );
      checks++;
      await page.locator("#reading-viewport").focus();
      await page.keyboard.press("Control+-");
      await ready();
      assert.equal(
        await page.locator("#reader-zoom input").inputValue(),
        "125%",
      );
      checks++;
      if (epub) {
        await page.locator("#toc-close").click();
        await page
          .locator("#epub-frame")
          .contentFrame()
          .locator("body")
          .click({ position: { x: 15, y: 15 } });
        await page.keyboard.press("Meta+0");
        await ready();
        assert.equal(
          await page.locator("#reader-zoom input").inputValue(),
          "100%",
        );
        checks++;
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -100);
        await page.keyboard.up("Control");
        await page.waitForFunction(
          () => document.querySelector("#reader-zoom input").value === "110%",
        );
        await ready();
        checks++;
      }
      await page.locator("#reader-zoom input").fill("bad");
      await page.locator("#reader-zoom input").press("Enter");
      assert(!Number.isNaN(await font()));
      checks++;
      await page.setViewportSize({ width: 820, height: 640 });
      const box = await page.locator("#reader-zoom").boundingBox();
      assert(box.x >= 0 && box.x + box.width <= 820);
      await page.setViewportSize({ width: 1100, height: 800 });
      checks++;
    }
    await page.goto(base + "/?mode=palm&book=demo-b");
    await page.setViewportSize({ width: 344, height: 560 });
    await ready();
    const font = () =>
      page
        .locator("#chapter-body p")
        .first()
        .evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
    const before = await font();
    await set(125, "#palm-zoom");
    assert(Math.abs((await font()) / before - 1.25) < 0.01);
    checks++;
    await page.setViewportSize({ width: 224, height: 320 });
    await page.waitForTimeout(200);
    const box = await page.locator("#palm-zoom").boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 224);
    checks++;
    assert.equal(await page.locator("#palm-zoom input").inputValue(), "125%");
    checks++;
    await page.screenshot({ path: `qa/zoom/palm-${engine}.png` });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        checks,
        pdfExactScale: true,
        fitModes: true,
        positionAndPersistence: true,
        fontOnlyTextAndEpub: true,
        palm: true,
      }),
    );
  } finally {
    await browser.close();
    await api("/api/state", {
      prefs: {
        ...old.prefs,
        pdfZoomMode: old.prefs.pdfZoomMode || "legacy",
        pdfZoom: old.prefs.pdfZoom || 100,
        fontSize: old.prefs.fontSize || 21,
        palmScale: old.prefs.palmScale || 1,
        textMode: old.prefs.textMode || "pages",
        palmMode: old.prefs.palmMode || "pages",
        pdfMode: old.prefs.pdfMode || "scroll",
      },
    });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
