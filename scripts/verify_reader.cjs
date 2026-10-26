// Run against an isolated --demo server. Playwright is a development-only dependency.
const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const base = process.argv[2];
const engine = process.argv[3] || "chromium";
assert.ok(
  base,
  "Usage: node scripts/verify_reader.cjs http://127.0.0.1:PORT chromium|webkit",
);
assert.ok(["chromium", "webkit"].includes(engine));
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
  assert.ok(response.ok, result.error);
  return result;
}
async function ready(page) {
  await page.waitForFunction(
    () =>
      document.body.dataset.view === "reader" &&
      document.querySelector("#reading-viewport")?.getAttribute("aria-busy") ===
        "false" &&
      !document.querySelector("#ai-open").disabled &&
      document.querySelector("#reader-loading").hidden,
  );
}
async function pageNumber(page, epub) {
  return page.evaluate(
    (epub) => ({
      page: Number(
        (epub
          ? document.querySelector("#epub-frame").contentDocument.body
          : document.querySelector("#text-host")
        ).dataset.page,
      ),
      chapter: Number(document.querySelector("#page-label").dataset.chapter),
    }),
    epub,
  );
}
async function turned(page, epub, before) {
  await page.waitForFunction(
    ({ epub, before }) => {
      const chapter = Number(
        document.querySelector("#page-label").dataset.chapter,
      );
      const index = Number(
        (epub
          ? document.querySelector("#epub-frame").contentDocument.body
          : document.querySelector("#text-host")
        ).dataset.page,
      );
      return (
        !document.querySelector("#ai-open").disabled &&
        (chapter === before.chapter + 1 ||
          (chapter === before.chapter && index === before.page + 1))
      );
    },
    { epub, before },
  );
}
async function selectParagraph(page, epub) {
  return page.evaluate((epub) => {
    const doc = epub
      ? document.querySelector("#epub-frame").contentDocument
      : document;
    const paragraph = doc.querySelector(
      epub ? "#reader-flow p" : "#chapter-body p",
    );
    const range = doc.createRange();
    range.selectNodeContents(paragraph);
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
    return doc.getSelection().toString().trim();
  }, epub);
}
async function backgroundPositionSync(browser, failures) {
  await api("/api/state", {
    prefs: { palmMode: "pages" },
    positions: {
      "demo-b": {
        index: 2,
        page: 0,
        top: 0,
        anchor: null,
        updatedAt: Date.now(),
      },
    },
  });
  const page = await browser.newPage({ viewport: { width: 344, height: 560 } });
  page.on("pageerror", (error) => failures.push(error.message));
  let release, observed;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const polling = new Promise((resolve) => {
    observed = resolve;
  });
  let first = true;
  await page.route("**/api/library-version", async (route) => {
    if (first) {
      first = false;
      observed();
      await held;
    }
    await route.continue();
  });
  try {
    await page.goto(base + "/?mode=palm&book=demo-b");
    await ready(page);
    await Promise.race([
      polling,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("Position poll did not start")), 8000),
      ),
    ]);
    // A second window saves its older visible position while this window is about to turn.
    const state = await api("/api/state");
    await api("/api/state", {
      positions: {
        "demo-b": { ...state.positions["demo-b"], updatedAt: Date.now() },
      },
    });
    const before = await pageNumber(page, false);
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("palm-flip", { detail: 1 })),
    );
    await turned(page, false, before);
    const polled = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/state",
    );
    release();
    await polled;
    await page.waitForTimeout(120);
    assert.deepEqual(
      await pageNumber(page, false),
      { ...before, page: before.page + 1 },
      "A native command must protect its pending position from an older window's save.",
    );
    await page.waitForFunction(async () => {
      const data = await (await fetch("/api/state")).json();
      return data.positions["demo-b"].page === 1;
    });
  } finally {
    release();
    await page.close();
  }
  console.log(
    engine,
    "background page command survives a concurrent position poll",
  );
}
async function shortcutPreferences(browser, failures) {
  const page = await browser.newPage({ viewport: { width: 344, height: 560 } });
  page.on("pageerror", (error) => failures.push(error.message));
  await page.addInitScript(() => {
    window.shortcutMessages = [];
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          readerNative: {
            postMessage(message) {
              window.shortcutMessages.push(message);
            },
          },
        },
      },
    });
  });
  try {
    await page.goto(base + "/?mode=palm&book=demo-b");
    await ready(page);
    await page.locator("#palm-settings").click();
    const control = page.locator('#quick-settings [data-pref="palmKeys"]');
    const before = await pageNumber(page, false);
    await control.selectOption("letters");
    await page.waitForFunction(() =>
      window.shortcutMessages.some((value) => value.reader?.keys === "letters"),
    );
    assert.equal((await api("/api/state")).prefs.palmKeys, "letters");
    assert.deepEqual(
      await pageNumber(page, false),
      before,
      "Changing shortcuts must not reflow or move the reading position.",
    );
    await control.selectOption("off");
    await page.waitForFunction(
      () => window.shortcutMessages.at(-1)?.reader?.keys === "off",
    );
    await page.keyboard.press("Escape");
    await page
      .locator("#reading-viewport")
      .click({ position: { x: 30, y: 90 } });
    await page.keyboard.press("ArrowRight");
    await turned(page, false, before);
    await page.locator("#palm-settings").click();
    await control.selectOption("letters");
    await page.waitForFunction(
      () => window.shortcutMessages.at(-1)?.reader?.keys === "letters",
    );
    await page.reload();
    await ready(page);
    await page.locator("#palm-settings").click();
    assert.equal(
      await control.inputValue(),
      "letters",
      "Shortcut preferences survive reopening the reader.",
    );
    await page.evaluate(() => {
      window.shortcutLayoutChanges = 0;
      new MutationObserver((records) => {
        window.shortcutLayoutChanges += records.length;
      }).observe(document.querySelector("#text-host"), {
        attributes: true,
        attributeFilter: ["data-pages"],
      });
    });
    await page.keyboard.press("Escape");
    await page
      .locator("#reading-viewport")
      .click({ position: { x: 30, y: 90 } });
    const raceStart = await pageNumber(page, false);
    await page.keyboard.press("ArrowRight");
    await turned(page, false, raceStart);
    const concurrentMark = "sync-" + Date.now();
    const ownSave = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/state" &&
        !!response.request().postDataJSON()?.positions?.["demo-b"],
    );
    await api("/api/state", {
      prefs: { palmKeys: "off" },
      bookmarkChanges: {
        add: [
          {
            id: concurrentMark,
            book: "demo-b",
            label: "并发同步检查",
            detail: "原创测试记录",
            position: { index: 2, top: 0, page: 0 },
          },
        ],
      },
    });
    await ownSave;
    await page.waitForFunction(
      () => window.shortcutMessages.at(-1)?.reader?.keys === "off",
    );
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-mark="${id}"]`),
      concurrentMark,
    );
    assert.equal(
      await page.evaluate(() => window.shortcutLayoutChanges),
      0,
      "Changing shortcuts from another window must not rebuild the pages.",
    );
    await page.locator("#palm-settings").click();
    assert.equal(await control.inputValue(), "off");
    await control.selectOption("arrows");
    await page.waitForFunction(
      () => window.shortcutMessages.at(-1)?.reader?.keys === "arrows",
    );
  } finally {
    await page.close();
  }
  console.log(
    engine,
    "shortcut presets, persistence, native bridge and local navigation while disabled passed",
  );
}
(async () => {
  const collection = await api("/api/library");
  assert.ok(
    ["demo-a", "demo-b", "demo-e"].every((id) =>
      collection.books.some((book) => book.id === id),
    ),
    "Use the anonymous demo library.",
  );
  const original = await api("/api/state");
  const browser = await { chromium, webkit }[engine].launch();
  const failures = [];
  try {
    await api("/api/state", {
      prefs: { textMode: "pages", palmMode: "pages" },
    });
    for (const book of ["demo-b", "demo-a"]) {
      const epub = book === "demo-a";
      for (const palm of [false, true]) {
        await api("/api/state", {
          positions: {
            [book]: {
              index: 2,
              page: 0,
              top: 0,
              anchor: null,
              updatedAt: Date.now(),
            },
          },
        });
        const page = await browser.newPage({
          viewport: palm
            ? { width: 344, height: 560 }
            : { width: 1280, height: 900 },
        });
        page.on("pageerror", (error) => failures.push(error.message));
        await page.goto(
          base + (palm ? "/?mode=palm&book=" + book : "/#/read/" + book),
        );
        await ready(page);
        assert.equal(await page.locator("#reader-aside").isVisible(), !palm);
        if (!palm) await page.locator("#toc-close").click();
        const body = epub
          ? page.frameLocator("#epub-frame").locator("body")
          : page.locator("#reading-viewport");
        await body.click({ position: { x: 30, y: 100 } });
        const before = await pageNumber(page, epub);
        await page.keyboard.press("ArrowRight");
        await turned(page, epub, before);
        if (!palm) {
          await page.locator("#focus-button").click();
          await page.waitForTimeout(200);
          const focused = await pageNumber(page, epub);
          await page.keyboard.press("ArrowRight");
          await turned(page, epub, focused);
          await page.keyboard.press("Escape");
        }
        await selectParagraph(page, epub);
        await page.locator("#selection-toolbar").waitFor();
        await page.evaluate(
          (epub) =>
            (epub
              ? document.querySelector("#epub-frame").contentDocument
              : document
            )
              .getSelection()
              .removeAllRanges(),
          epub,
        );
        await page.locator("#selection-toolbar").waitFor({ state: "hidden" });
        const selected = await selectParagraph(page, epub);
        await page.locator("#ask-selection").click();
        await page.locator("#question-panel").waitFor();
        await page.waitForFunction(
          () => !document.querySelector("#ai-quote").hasAttribute("aria-busy"),
        );
        assert.equal(
          (await page.locator("#ai-quote").textContent()).trim(),
          selected,
        );
        await page.waitForTimeout(180);
        assert.equal(
          await page.locator("#selection-toolbar").isVisible(),
          false,
          "The toolbar must stay dismissed after asking.",
        );
        if (!palm) {
          const handle = page.locator("#question-drag"),
            rectangle = await handle.boundingBox();
          const initial = await page.locator("#question-panel").boundingBox();
          await page.mouse.move(rectangle.x + 20, rectangle.y + 8);
          await page.mouse.down();
          await page.mouse.move(rectangle.x - 180, rectangle.y - 80, {
            steps: 10,
          });
          await page.mouse.up();
          const moved = await page.locator("#question-panel").boundingBox();
          assert.ok(
            moved.x < initial.x - 100,
            "Question panel moves with its title.",
          );
          await handle.focus();
          await page.keyboard.press("ArrowLeft");
          assert.equal(
            Math.round((await page.locator("#question-panel").boundingBox()).x),
            Math.round(moved.x - 8),
          );
          await page.setViewportSize({ width: 640, height: 640 });
          await page.waitForFunction(() => {
            const rectangle = document
              .querySelector("#question-panel")
              .getBoundingClientRect();
            return (
              rectangle.left >= 0 &&
              rectangle.top >= 0 &&
              rectangle.right <= innerWidth &&
              rectangle.bottom <= innerHeight
            );
          });
          const clamped = await page.locator("#question-panel").boundingBox();
          assert.ok(
            clamped.x >= 0 &&
              clamped.y >= 0 &&
              clamped.x + clamped.width <= 640 &&
              clamped.y + clamped.height <= 640,
            "Resizing keeps the panel reachable.",
          );
        }
        await page.close();
        console.log(
          engine,
          book,
          palm ? "palm" : "reader",
          "pagination, selection and questions passed",
        );
      }
    }
    await shortcutPreferences(browser, failures);
    await backgroundPositionSync(browser, failures);
    const interrupted = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "no-preference",
    });
    interrupted.on("pageerror", (error) => failures.push(error.message));
    await interrupted.goto(base + "/#/read/demo-b");
    await ready(interrupted);
    const last = await interrupted
      .locator("#text-host")
      .getAttribute("data-pages");
    await interrupted.locator("#page-label").click();
    await interrupted.locator("#page-jump-input").fill(last);
    await interrupted.locator("#page-jump-input").press("Enter");
    await interrupted.evaluate(() => {
      const view = document.querySelector("#reading-viewport"),
        animate = view.animate;
      view.animate = function (...arguments_) {
        const animation = animate.apply(this, arguments_);
        view.animate = animate;
        queueMicrotask(() => {
          window.testAnimationCancelled = true;
          animation.cancel();
        });
        return animation;
      };
    });
    await interrupted.keyboard.press("ArrowRight");
    await interrupted.waitForFunction(
      () => window.testAnimationCancelled === true,
    );
    await interrupted.locator("#next-button:not([disabled])").waitFor();
    const recovered = await pageNumber(interrupted, false);
    await interrupted.keyboard.press("ArrowRight");
    await turned(interrupted, false, recovered);
    await interrupted.close();
    console.log(engine, "cancelled chapter animation releases page controls");
    await api("/api/state", {
      positions: {
        "demo-e": {
          index: 1,
          top: 0,
          pdfY: 0,
          anchor: null,
          updatedAt: Date.now(),
        },
      },
    });
    const pdf = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    pdf.on("pageerror", (error) => failures.push(error.message));
    await pdf.goto(base + "/#/read/demo-e");
    await ready(pdf);
    await pdf.locator("#toc-close").click();
    await pdf.locator("#page-label").click();
    await pdf.locator("#page-jump-input").fill("1");
    await pdf.locator("#page-jump-input").press("Enter");
    await pdf
      .locator('.pdf-page[data-page="1"][data-ocr="ready"]')
      .waitFor({ timeout: 150000 });
    const sample = await pdf.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.pdf-page[data-page="1"] .textLayer span',
        ),
      ];
      const viewport = document
        .querySelector("#reading-viewport")
        .getBoundingClientRect();
      for (let index = 0; index < nodes.length - 4; index++) {
        const chars = nodes.slice(index, index + 4),
          boxes = chars.map((node) => node.getBoundingClientRect());
        if (!chars.every((node) => /^[a-z]$/i.test(node.textContent.trim())))
          continue;
        if (
          boxes.some(
            (box) =>
              box.width < 2 ||
              box.top < viewport.top + 8 ||
              box.bottom > viewport.bottom - 8,
          )
        )
          continue;
        if (
          boxes.some(
            (box, i) =>
              i &&
              (Math.abs(box.bottom - boxes[0].bottom) >
                Math.max(boxes[0].height, box.height) * 0.4 ||
                box.left < boxes[i - 1].left ||
                box.left - boxes[i - 1].right > 15),
          )
        )
          continue;
        return {
          expected: chars
            .map((node) => node.textContent)
            .join("")
            .trim(),
          start: [
            boxes[0].left + boxes[0].width * 0.1,
            boxes[0].top + boxes[0].height * 0.5,
          ],
          end: [
            boxes[3].left + boxes[3].width * 0.9,
            boxes[3].top + boxes[3].height * 0.5,
          ],
        };
      }
      throw Error("No visible OCR character boxes");
    });
    await pdf.mouse.move(...sample.start);
    await pdf.mouse.down();
    await pdf.mouse.move(...sample.end, { steps: 20 });
    await pdf.mouse.up();
    await pdf.locator("#selection-toolbar").waitFor();
    assert.equal(
      await pdf.evaluate(() => getSelection().toString().trim()),
      sample.expected,
    );
    await pdf.evaluate(() => getSelection().removeAllRanges());
    await pdf.locator("#selection-toolbar").waitFor({ state: "hidden" });
    const enhancement = await api("/api/enrichment?book=demo-e&page=1");
    await pdf.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.readerTestCopied = text;
          },
        },
      });
    });
    for (const [name, kind] of [
      ["公式", "equation"],
      ["表格", "table"],
      ["插图", "image"],
    ]) {
      await pdf
        .locator(`.pdf-page[data-page="1"] [aria-label="选择完整${name}"]`)
        .click();
      await pdf.locator("#selection-toolbar").waitFor();
      const original = enhancement.blocks.find(
        (block) => block.type === kind,
      )?.text;
      if (kind !== "image") {
        await pdf.locator("#copy-selection").click();
        assert.equal(
          await pdf.evaluate(() => window.readerTestCopied),
          original,
          "Original selection copy keeps raw LaTeX / TSV",
        );
      }
      await pdf.locator("#ask-selection").click();
      await pdf.locator("#question-panel").waitFor();
      await pdf.waitForFunction(
        () => !document.querySelector("#ai-quote").hasAttribute("aria-busy"),
      );
      if (kind === "equation")
        assert.ok(
          await pdf.locator("#ai-quote math").count(),
          "Formula quote is rendered as MathML",
        );
      if (kind === "table")
        assert.equal(
          await pdf.locator("#ai-quote table tr").count(),
          original.split("\n").length,
          "Table quote renders its complete rows",
        );
      assert.equal(await pdf.locator("#question-image").isVisible(), true);
      if (kind !== "image") {
        await pdf.locator("#copy-question").click();
        assert.ok(
          (await pdf.evaluate(() => window.readerTestCopied)).endsWith(
            "\n\n" + original,
          ),
          "Rendered quote still copies its original source",
        );
      }
      await pdf.keyboard.press("Escape");
      await pdf.locator("#selection-toolbar").waitFor({ state: "hidden" });
    }
    await pdf.close();
    console.log(
      engine,
      "PDF selection, rendered source objects, original copy and toolbar cleanup passed",
    );
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.on("pageerror", (error) => failures.push(error.message));
    await page.route("**/content/**", async (route) => {
      if (!/\.x?html?$/.test(new URL(route.request().url()).pathname))
        return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          /<body([^>]*)>/i,
          '<body$1><script>top.document.body.dataset.bookScript="ran"</script><img src="/missing-book-image" onerror="top.document.body.dataset.bookHandler=\"ran\"">',
        ),
      });
    });
    await page.goto(base + "/#/read/demo-a");
    await ready(page);
    assert.equal(
      await page.evaluate(
        () =>
          !!document.body.dataset.bookScript ||
          !!document.body.dataset.bookHandler,
      ),
      false,
    );
    assert.equal(
      await page
        .frameLocator("#epub-frame")
        .locator("script,[onerror]")
        .count(),
      0,
    );
    await page.evaluate(() => {
      const doc = document.querySelector("#epub-frame").contentDocument,
        script = doc.createElement("script");
      script.textContent = 'top.document.body.dataset.bookScript="ran"';
      doc.body.append(script);
    });
    assert.equal(
      await page.evaluate(() => !!document.body.dataset.bookScript),
      false,
      "CSP also forbids code inserted after sanitization.",
    );
    await page.close();
    assert.deepEqual(failures, []);
    console.log(engine, "untrusted book scripts remain blocked");
    await api("/api/state", {
      positions: {
        "demo-a": {
          index: 2,
          page: 0,
          top: 0,
          anchor: null,
          fragment: "",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyImage = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    legacyImage.on("pageerror", (error) => failures.push(error.message));
    const inlineImage =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    await legacyImage.route(
      "**/demo-data/books/demo-a/content/OPS/chapter-1.xhtml",
      async (route) => {
        const response = await route.fetch();
        const text = await response.text();
        assert.ok(text.includes('src="figure.svg"'));
        await route.fulfill({
          response,
          body: text.replace(
            'src="figure.svg"',
            'src="../' + inlineImage + '"',
          ),
        });
      },
    );
    await legacyImage.goto(base + "/#/read/demo-a");
    await ready(legacyImage);
    await legacyImage.waitForFunction(() => {
      const image = document
        .querySelector("#epub-frame")
        .contentDocument.querySelector("#reader-flow img");
      return (
        image?.src.startsWith("data:image/gif;") && image.naturalWidth === 1
      );
    });
    await legacyImage.close();
    assert.deepEqual(failures, []);
    console.log(
      engine,
      "legacy converted inline images display without changing stored content",
    );
  } finally {
    await browser.close();
    await api("/api/state", {
      prefs: {
        textMode: original.prefs.textMode || "pages",
        palmMode: original.prefs.palmMode || "pages",
        palmKeys: original.prefs.palmKeys || "arrows",
      },
      positions: Object.fromEntries(
        Object.entries(original.positions || {}).map(([book, position]) => [
          book,
          { ...position, updatedAt: Date.now() },
        ]),
      ),
      bookmarks: original.bookmarks,
      lastBook: original.lastBook,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
