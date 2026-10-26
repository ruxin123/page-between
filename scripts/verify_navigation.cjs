// Run against an isolated --demo server; the EPUB is original anonymous test content.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "chromium";
assert.ok(
  base,
  "Usage: node scripts/verify_navigation.cjs http://127.0.0.1:PORT chromium|webkit",
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
function fixture(compact = false) {
  const sections = [1, 2, 3]
    .map(
      (index) =>
        `<section><h2 ${compact ? "" : 'style="break-before:column"'} ${index !== 2 ? `id="part-${index}"` : ""}>${index === 2 ? '<span id="part-2"></span>' : ""}第${index}章 原创样本</h2>${Array.from({ length: compact ? 1 : 30 }, (_, paragraph) => `<p>第${index}章第${paragraph + 1}段。这是自编的目录测试文字，用于验证分页、滚动、书签与返回位置。Each paragraph belongs to its original chapter and is used only for anonymous navigation testing.</p>`).join("")}</section>`,
    )
    .join("");
  const entries = {
    "META-INF/container.xml":
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OPS/book.opf":
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:page-between:fragment-test</dc:identifier><dc:title>原创目录样本</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="body"/></spine></package>',
    "OPS/body.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" lang="zh"><head><title>原创目录样本</title></head><body>${sections}</body></html>`,
    "OPS/nav.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="body.xhtml">正文</a><ol>${[1, 2, 3].map((index) => `<li><a href="body.xhtml#part-${index}">第${index}章 原创样本</a></li>`).join("")}</ol></li></ol></nav></body></html>`,
  };
  if (compact)
    for (const name of Object.keys(entries))
      entries[name] = entries[name]
        .replaceAll("原创目录样本", "原创选段样本")
        .replace(
          "urn:page-between:fragment-test",
          "urn:page-between:selection-test",
        );
  return execFileSync(
    process.env.PYTHON || "python3",
    [
      "-c",
      "import io,json,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n z.writestr('mimetype','application/epub+zip',compress_type=zipfile.ZIP_STORED)\n for name,text in json.load(sys.stdin).items(): z.writestr(name,text)\nsys.stdout.buffer.write(b.getvalue())",
    ],
    { input: JSON.stringify(entries) },
  );
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
async function active(page, fragment) {
  try {
    await page.waitForFunction(
      (fragment) => {
        const rows = document.querySelectorAll(
          '#toc-list [aria-current="true"]',
        );
        return (
          rows.length === 1 &&
          rows[0].dataset.fragment === fragment &&
          document.querySelector("#position-label").textContent ===
            rows[0].querySelector("span").textContent
        );
      },
      fragment,
      { timeout: 10000 },
    );
  } catch (error) {
    console.error(
      "Anonymous navigation state",
      await page.evaluate(() => ({
        active: [
          ...document.querySelectorAll('#toc-list [aria-current="true"]'),
        ].map((row) => row.dataset.fragment),
        label: document.querySelector("#position-label").textContent,
        page: document.querySelector("#epub-frame").contentDocument.body.dataset
          .page,
        mode: document.body.dataset.mode,
        scroll: document.querySelector("#reading-viewport").scrollTop,
        targets: [1, 2, 3].map((index) => {
          const r = document
            .querySelector("#epub-frame")
            .contentDocument.getElementById("part-" + index)
            .getBoundingClientRect();
          return [r.left, r.top, r.width, r.height];
        }),
      })),
    );
    throw error;
  }
}
async function pageIndex(page) {
  return page
    .frameLocator("#epub-frame")
    .locator("body")
    .getAttribute("data-page");
}
async function chapterJumps(browser, failures) {
  for (const mode of ["pages", "scroll"]) {
    for (const book of ["demo-b", "demo-a", "demo-c"]) {
      await api("/api/state", {
        prefs: { textMode: mode, pdfMode: mode },
        positions: {
          [book]: {
            index: 1,
            page: 0,
            top: 0,
            anchor: null,
            updatedAt: Date.now(),
          },
        },
      });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      page.on("pageerror", (error) => failures.push(error.message));
      let release,
        observed,
        armed = false;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const polling = new Promise((resolve) => {
        observed = resolve;
      });
      await page.route("**/api/state", async (route) => {
        if (armed && route.request().method() === "GET") {
          armed = false;
          const response = await route.fetch();
          observed();
          await held;
          await route.fulfill({ response });
        } else await route.continue();
      });
      const at = async (index) => {
        await ready(page);
        await page.waitForFunction(
          (index) =>
            document.querySelector("#page-label").dataset.chapter ===
            String(index),
          index,
        );
      };
      try {
        await page.goto(base + "/#/read/" + book);
        await at(1);
        const initiallyOpen = await page.locator("#reader-aside").isVisible();
        if (!initiallyOpen) await page.locator("#toc-toggle").click();
        armed = true;
        await polling;
        await page.locator('#toc-list [data-index="3"]').first().click();
        await at(3);
        release();
        // Wait past two synchronization polls, without a key press or manual flush.
        await page.waitForTimeout(3900);
        assert.equal(
          await page.locator("#page-label").getAttribute("data-chapter"),
          "3",
          `${book}/${mode}: an older poll must not undo a chapter jump`,
        );
        assert.equal(
          (await api("/api/state")).positions[book].index,
          3,
          "A chapter jump must persist without further reading input.",
        );
        assert.equal(
          initiallyOpen,
          true,
          "The main reader opens with its TOC visible.",
        );
        await page.reload();
        await at(3);
        assert.equal(
          await page.locator("#toc-toggle").getAttribute("aria-expanded"),
          "true",
        );
        await page.locator('#toc-list [data-index="2"]').first().click();
        await at(2);
        await page.locator("#reader-back").click();
        await at(3);
        await page.waitForTimeout(2100);
        assert.equal(
          await page.locator("#page-label").getAttribute("data-chapter"),
          "3",
          "Returning to a previous location must also survive synchronization.",
        );
        assert.equal((await api("/api/state")).positions[book].index, 3);
        if (book === "demo-a" && mode === "pages") {
          const chapter = (await api("/api/library")).books.find(
            (item) => item.id === book,
          ).chapters[1].url;
          let unblock, started;
          const delayed = new Promise((resolve) => {
            unblock = resolve;
          });
          const loading = new Promise((resolve) => {
            started = resolve;
          });
          await page.route(base + chapter, async (route) => {
            started();
            await delayed;
            await route.continue();
          });
          try {
            await page.locator('#toc-list [data-index="2"]').first().click();
            await loading;
            await page.locator('#toc-list [data-index="3"]').first().click();
            await at(3);
            const completed = page.waitForResponse(
              (response) => new URL(response.url()).pathname === chapter,
            );
            unblock();
            await completed;
            await page.waitForTimeout(200);
            assert.equal(
              await page.locator("#page-label").getAttribute("data-chapter"),
              "3",
              "A slower earlier chapter must not replace the last requested chapter.",
            );
            assert.equal((await api("/api/state")).positions[book].index, 3);
          } finally {
            unblock();
          }
        }
        await page.locator("#toc-close").click();
        assert.equal(
          await page.locator("#toc-toggle").getAttribute("aria-expanded"),
          "false",
        );
      } finally {
        release();
        await page.close();
      }
    }
  }
  console.log(
    engine,
    "TXT, EPUB and PDF chapter jumps survive delayed polls, reload and return in both reading modes",
  );

  const exported = await api("/api/export/epub", {
    book: "demo-c",
    pages: "1-2",
  });
  const data = await (await fetch(base + exported.download)).arrayBuffer();
  const response = await fetch(
    base + "/api/import?name=linked-navigation.epub&parse=0",
    {
      method: "POST",
      body: data,
    },
  );
  const { book } = await response.json();
  assert.ok(response.ok && book.sourcePdfHash);
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.on("pageerror", (error) => failures.push(error.message));
  try {
    await page.goto(base + "/#/read/" + book.id);
    await ready(page);
    await page.locator("#source-pdf-open").click();
    await ready(page);
    assert.equal(await page.locator("#pdf-paper").isVisible(), true);
    await page.waitForTimeout(2100);
    assert.equal(
      await page.locator("#page-label").getAttribute("data-chapter"),
      "1",
    );
    assert.equal((await api("/api/state")).positions["demo-c"].index, 1);
    await page.locator("#reader-back").click();
    await ready(page);
    await page.waitForTimeout(2100);
    assert.equal(await page.locator("#epub-frame").isVisible(), true);
    assert.equal(new URL(page.url()).hash, "#/read/" + book.id);
  } finally {
    await page.close();
  }
  console.log(
    engine,
    "original-PDF jumps and cross-book return retain their destinations",
  );
}
(async () => {
  const collection = await api("/api/library");
  assert.ok(
    collection.books.some((book) => book.id === "demo-a"),
    "Use an isolated anonymous demo library.",
  );
  const original = await api("/api/state");
  const response = await fetch(
    base + "/api/import?name=fragment-test.epub&parse=0",
    { method: "POST", body: fixture() },
  );
  const imported = await response.json();
  assert.ok(response.ok, imported.error);
  const book = imported.book;
  assert.equal(book.chapters.length, 1);
  assert.equal(
    book.chapters[0].title,
    "正文",
    "In-file subsections must not overwrite the spine label with the last section.",
  );
  const browser = await { chromium, webkit }[engine].launch(),
    failures = [];
  let marks = [];
  try {
    await chapterJumps(browser, failures);
    await api("/api/state", {
      prefs: { textMode: "pages" },
      positions: {
        [book.id]: {
          index: 1,
          page: 0,
          top: 0,
          fragment: "",
          anchor: null,
          updatedAt: Date.now(),
        },
      },
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto(base + "/#/read/" + book.id);
    await ready(page);
    if (!(await page.locator("#reader-aside").isVisible()))
      await page.locator("#toc-toggle").click();
    await active(page, "part-1");
    const focused = await page
      .locator('#toc-list [aria-current="true"]')
      .elementHandle();
    await focused.focus();
    const refreshed = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/library") return false;
      const data = await response.json();
      return data.books.some(
        (item) => item.id === book.id && item.onShelf === !book.onShelf,
      );
    });
    await api("/api/books/" + book.id, { onShelf: !book.onShelf });
    await refreshed;
    await page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/state" &&
        request.method() === "GET",
    );
    assert.equal(
      await focused.evaluate(
        (node) => node.isConnected && node.ownerDocument.activeElement === node,
      ),
      true,
      "An unrelated shelf change must preserve the focused TOC node.",
    );
    const row = page.locator('#toc-list [data-fragment="part-2"]');
    await row.focus();
    await page.keyboard.press("Enter");
    await ready(page);
    await active(page, "part-2");
    assert.equal(
      await row.evaluate((node) => node.closest("details").open),
      true,
    );
    const second = Number(await pageIndex(page));
    await page.locator("#next-button").click();
    await page.waitForFunction(
      (before) =>
        Number(
          document.querySelector("#epub-frame").contentDocument.body.dataset
            .page,
        ) ===
        before + 1,
      second,
    );
    await active(page, "part-2");
    const beforeJump = await pageIndex(page);
    await page.locator('#toc-list [data-fragment="part-3"]').click();
    await ready(page);
    await active(page, "part-3");
    await page.locator("#reader-back").click();
    await ready(page);
    await active(page, "part-2");
    assert.equal(await pageIndex(page), beforeJump);
    await page.evaluate(() => window.readerFlush());
    await page.reload();
    await ready(page);
    await active(page, "part-2");
    assert.equal(await pageIndex(page), beforeJump);
    if (!(await page.locator("#reader-aside").isVisible()))
      await page.locator("#toc-toggle").click();
    const oldMarks = new Set(
      (await api("/api/state")).bookmarks.map((mark) => mark.id),
    );
    if (
      (await page.locator("#bookmark-button").getAttribute("aria-pressed")) !==
      "true"
    )
      await page.locator("#bookmark-button").click();
    await page.locator('#bookmark-button[aria-pressed="true"]').waitFor();
    const saved = (await api("/api/state")).bookmarks.filter(
      (mark) => mark.book === book.id,
    );
    marks = saved
      .filter((mark) => !oldMarks.has(mark.id))
      .map((mark) => mark.id);
    const bookmark = saved.find(
      (mark) => mark.position.page + 1 === Number(beforeJump),
    );
    assert.equal(bookmark.label, "第2章 原创样本");
    await page.locator('#toc-list [data-fragment="part-3"]').click();
    await ready(page);
    await active(page, "part-3");
    await page.locator("#bookmark-tab").click();
    await page.locator(`[data-mark="${bookmark.id}"]`).click();
    await ready(page);
    await active(page, "part-2");
    assert.equal(await pageIndex(page), beforeJump);
    await page.locator("#toc-tab").click();
    await page.locator("#reading-mode").click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#reading-viewport")
          .classList.contains("paged"),
    );
    await active(page, "part-2");
    await page.locator('#toc-list [data-fragment="part-3"]').click();
    await ready(page);
    await active(page, "part-3");
    await page.evaluate(() => {
      document.querySelector("#reading-viewport").scrollTop = 0;
    });
    await active(page, "part-1");
    await page.evaluate(async () => {
      const { epubTocAtAnchor, fragmentTarget } = await import(
        "/ui/navigation.mjs"
      );
      const doc = document.implementation.createHTMLDocument(
        "Original anchor edge cases",
      );
      doc.body.innerHTML =
        '<p>ABC<span id="a"></span>DEF<a name="b"></a>GHI</p>';
      const toc = ["a", "b"].map((fragment) => ({
        title: fragment,
        index: 1,
        fragment,
      }));
      const element = doc.querySelector("p");
      if (
        epubTocAtAnchor(toc, 1, { doc, element, offset: 4 }).fragment !== "a" ||
        epubTocAtAnchor(toc, 1, { doc, element, offset: 7 }).fragment !== "b" ||
        fragmentTarget(doc, "b") !== doc.querySelector("a")
      )
        throw Error(
          "Inline and legacy named anchors must resolve by character position.",
        );
    });
    await page.locator('#toc-list [data-fragment="part-2"]').click();
    await ready(page);
    await active(page, "part-2");
    await page.evaluate(() => window.readerFlush());
    await page.close();
    await api("/api/state", { prefs: { palmMode: "pages" } });
    const palm = await browser.newPage({
      viewport: { width: 344, height: 560 },
    });
    palm.on("pageerror", (error) => failures.push(error.message));
    await palm.goto(base + "/?mode=palm&book=" + book.id);
    await ready(palm);
    await active(palm, "part-2");
    const smallPage = Number(await pageIndex(palm));
    await palm.keyboard.press("ArrowRight");
    await palm.waitForFunction(
      (before) =>
        Number(
          document.querySelector("#epub-frame").contentDocument.body.dataset
            .page,
        ) ===
        before + 1,
      smallPage,
    );
    await active(palm, "part-2");
    await palm.setViewportSize({ width: 280, height: 440 });
    await active(palm, "part-2");
    await palm.close();
    const pdfBook = collection.books.find((item) => item.id === "demo-c");
    await api("/api/state", {
      prefs: { pdfMode: "scroll" },
      positions: {
        [pdfBook.id]: { index: 1, top: 0, anchor: null, updatedAt: Date.now() },
      },
    });
    const pdf = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    pdf.on("pageerror", (error) => failures.push(error.message));
    await pdf.goto(base + "/#/read/" + pdfBook.id);
    await ready(pdf);
    const pdfRow = await pdf
      .locator("#toc-list [data-toc-entry]")
      .first()
      .elementHandle();
    assert.ok(pdfRow, "The native PDF sample must have an outline.");
    await pdf.locator("#page-label").click();
    await pdf.locator("#page-jump-input").fill("2");
    await pdf.locator("#page-jump-input").press("Enter");
    await pdf.waitForFunction(
      () => document.querySelector("#page-label").dataset.chapter === "2",
    );
    assert.equal(
      await pdfRow.evaluate((node) => node.isConnected),
      true,
      "PDF page jumps must preserve the TOC nodes.",
    );
    await pdf.locator('.pdf-page[data-page="3"]').scrollIntoViewIfNeeded();
    await pdf.waitForFunction(
      () => Number(document.querySelector("#page-label").dataset.chapter) >= 3,
    );
    assert.equal(
      await pdfRow.evaluate((node) => node.isConnected),
      true,
      "PDF scrolling must preserve the TOC nodes.",
    );
    await pdf.close();
    const compactResponse = await fetch(
      base + "/api/import?name=selection-test.epub&parse=0",
      { method: "POST", body: fixture(true) },
    );
    const compactBook = (await compactResponse.json()).book;
    assert.ok(compactResponse.ok);
    await api("/api/state", {
      prefs: { textMode: "pages" },
      positions: {
        [compactBook.id]: {
          index: 1,
          page: 0,
          top: 0,
          anchor: null,
          fragment: "",
          updatedAt: Date.now(),
        },
      },
    });
    const selecting = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    });
    selecting.on("pageerror", (error) => failures.push(error.message));
    await selecting.route("**/api/ai/status", (route) =>
      route.fulfill({
        json: {
          configured: true,
          model: "anonymous-fixture",
          host: "localhost",
          supportsImages: false,
        },
      }),
    );
    const sent = selecting.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/ai/start" &&
        request.method() === "POST",
    );
    await selecting.route("**/api/ai/start", async (route) => {
      await route.fulfill({
        status: 503,
        json: {
          error: "Anonymous request captured by the test; no model was called.",
        },
      });
    });
    await selecting.goto(base + "/#/read/" + compactBook.id);
    await ready(selecting);
    await active(selecting, "part-1");
    const selectedText = await selecting.evaluate(() => {
      const doc = document.querySelector("#epub-frame").contentDocument;
      const paragraph = doc.querySelectorAll("#reader-flow p")[1];
      const range = doc.createRange();
      range.selectNodeContents(paragraph);
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(range);
      return doc.getSelection().toString();
    });
    assert.ok(selectedText.startsWith("第2章"));
    await selecting.locator("#selection-toolbar").waitFor();
    await selecting.locator("#ask-selection").click();
    assert.match(
      await selecting.locator("#question-source").textContent(),
      /第2章 原创样本/,
    );
    await selecting.locator("#question-input").fill("解释这段自编文字。");
    await selecting.locator("#ai-submit").click();
    const payload = (await sent).postDataJSON();
    assert.equal(payload.source.position.fragment, "part-2");
    assert.match(payload.source.citation, /第2章 原创样本/);
    assert.equal(payload.source.quote, selectedText);
    await selecting.close();
    assert.deepEqual(failures, []);
    console.log(
      engine,
      "shared-document navigation, bookmarks, palm reading, stable PDF outline and selection-based chapter citations passed",
    );
  } finally {
    await browser.close();
    await api("/api/books/" + book.id, { onShelf: book.onShelf });
    await api("/api/state", {
      prefs: original.prefs,
      positions: Object.fromEntries(
        Object.entries(original.positions || {}).map(([id, position]) => [
          id,
          { ...position, updatedAt: Date.now() },
        ]),
      ),
      bookmarkChanges: { remove: marks },
      lastBook: original.lastBook,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
