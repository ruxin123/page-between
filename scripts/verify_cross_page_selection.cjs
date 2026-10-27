// Run create_rendering_sample.py in the same isolated library first.
const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["chromium", "webkit"].includes(engine));
async function api(path, body) {
  const response = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  assert(response.ok, result.error);
  return result;
}
(async () => {
  const book = (await api("/api/library")).books.find(
    (book) => book.title === "Original rendering contract",
  );
  assert(book, "Create the original rendering sample first.");
  const previous = await api("/api/state");
  await api("/api/state", {
    prefs: { pdfMode: "scroll", pdfZoom: 75 },
    positions: { [book.id]: { index: 1, top: 0, updatedAt: Date.now() } },
  });
  const browser = await { chromium, webkit }[engine].launch();
  const errors = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text) => {
            window.copiedRange = text;
          },
        },
      }),
    );
    await page.goto(base + "/#/read/" + book.id);
    await page.waitForFunction(() =>
      [1, 2].every(
        (index) =>
          document.querySelector(`.pdf-page[data-page="${index}"] .textLayer`)
            ?._canonical,
      ),
    );
    for (const reverse of [false, true]) {
      await page.evaluate((reverse) => {
        const group = (page, text) =>
          [
            ...document
              .querySelector(`.pdf-page[data-page="${page}"] .textLayer`)
              ._canonical.mapped.values(),
          ].find((entry) => entry.group.text === text).group;
        const first = group(1, "x^2+1").nodes[0],
          last = group(2, "name\tvalue\nfirst\t1\nsecond\t2").nodes.at(-1);
        const a = [first.firstChild, 0],
          b = [last.firstChild, last.textContent.length];
        getSelection().setBaseAndExtent(
          ...(reverse ? b : a),
          ...(reverse ? a : b),
        );
      }, reverse);
      await page.locator("#selection-toolbar").waitFor({ state: "visible" });
      await page.locator("#copy-selection").click();
      const raw = await page.evaluate(() => window.copiedRange);
      assert(raw.includes("x^2+1") && raw.includes(String.raw`\frac{a}{b}`));
      assert(raw.includes("name\tvalue\nfirst\t1\nsecond\t2"));
      const request = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/ai/preview",
      );
      await page.locator("#ask-selection").click();
      const payload = (await request).postDataJSON();
      assert.equal(payload.position.index, 1);
      assert.equal(payload.position.endIndex, 2);
      assert.equal(payload.quote, raw);
      await page.waitForFunction(
        () =>
          document.querySelector("#ai-quote mfrac") &&
          document.querySelector("#ai-quote table"),
      );
      assert.equal(await page.locator("#ai-quote math").count(), 2);
      assert.equal(await page.locator("#ai-quote table tr").count(), 3);
      assert(
        (await page.locator("#question-source").textContent()).includes(
          "PDF 第 1–2 页",
        ),
      );
      await page.locator("#copy-question").click();
      assert((await page.evaluate(() => window.copiedRange)).endsWith(raw));
      await page.locator("#question-close").click();
    }
    const boundaries = await page.evaluate(async () => {
      const { pdfSelectionPages } = await import("/ui/pdf-selection.mjs");
      const root = document.querySelector("#pdf-paper"),
        a = root.querySelector('[data-page="1"] .textLayer'),
        b = root.querySelector('[data-page="2"] .textLayer');
      const range = document.createRange();
      range.setStart(a, 0);
      range.setEnd(b, 0);
      const first = pdfSelectionPages(range, root).map((page) =>
        Number(page.dataset.page),
      );
      range.setStart(a, a.childNodes.length);
      range.setEnd(b, b.childNodes.length);
      const second = pdfSelectionPages(range, root).map((page) =>
        Number(page.dataset.page),
      );
      return { first, second };
    });
    assert.deepEqual(boundaries, { first: [1], second: [2] });
    // Physical pointer selection crosses a page boundary while the viewport scrolls.
    for (const reverse of [false, true]) {
      const points = await page.evaluate((reverse) => {
        getSelection().removeAllRanges();
        const find = (index, prefix) =>
          [
            ...document.querySelectorAll(
              `.pdf-page[data-page="${index}"] .textLayer span`,
            ),
          ].find((node) => node.textContent.startsWith(prefix));
        ((window.pointerFirst = find(1, "The selection")),
          (window.pointerLast = find(2, "A line before")));
        const node = reverse ? pointerLast : pointerFirst;
        const view = document.querySelector("#reading-viewport"),
          root = node.closest(".pdf-page");
        view.scrollTop =
          root.offsetTop + (reverse ? 0 : root.offsetHeight * 0.15);
        window.pointerStart = node.firstChild;
        return { before: view.scrollTop };
      }, reverse);
      const caret = async (last) =>
        page.evaluate(
          ({ reverse, last }) => {
            const node = last
              ? reverse
                ? pointerFirst
                : pointerLast
              : reverse
                ? pointerLast
                : pointerFirst;
            const offset = last ? 12 : 7,
              range = document.createRange();
            range.setStart(node.firstChild, offset);
            range.setEnd(node.firstChild, offset + 1);
            const box = range.getBoundingClientRect();
            return {
              x: box.left + box.width * 0.2,
              y: box.top + box.height * 0.5,
            };
          },
          { reverse, last },
        );
      const start = await caret(false);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.wheel(0, reverse ? -700 : 700);
      await page.waitForFunction(
        ({ before, reverse }) =>
          reverse
            ? document.querySelector("#reading-viewport").scrollTop <
              before - 100
            : document.querySelector("#reading-viewport").scrollTop >
              before + 100,
        { ...points, reverse },
      );
      const end = await caret(true);
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      const selected = await page.evaluate(() => ({
        anchor: getSelection().anchorNode === pointerStart,
        offset: getSelection().anchorOffset,
        text: getSelection().toString(),
      }));
      assert(
        selected.anchor && selected.offset >= 6 && selected.offset <= 8,
        JSON.stringify(selected),
      );
      assert(
        !selected.text.includes("First original page"),
        "The drag must not jump back to the start of the page.",
      );
      await page.locator("#selection-toolbar").waitFor({ state: "visible" });
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        forwardAndReverse: true,
        crossPageCopy: true,
        formulasOnBothPages: true,
        secondPageTable: true,
        citationRange: true,
        emptyBoundaryExcluded: true,
        pointerDragWhileScrolling: true,
      }),
    );
  } finally {
    await browser.close();
    await api("/api/state", {
      prefs: {
        pdfMode: previous.prefs.pdfMode || "scroll",
        pdfZoom: previous.prefs.pdfZoom || 100,
      },
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
