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
function fixture() {
  const sections = [1, 2, 3]
    .map(
      (index) =>
        `<section><h2 style="break-before:column" ${index !== 2 ? `id="part-${index}"` : ""}>${index === 2 ? '<span id="part-2"></span>' : ""}第${index}章 原创样本</h2>${Array.from({ length: 30 }, (_, paragraph) => `<p>第${index}章第${paragraph + 1}段。这是自编的目录测试文字，用于验证分页、滚动、书签与返回位置。Each paragraph belongs to its original chapter and is used only for anonymous navigation testing.</p>`).join("")}</section>`,
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
  await page.locator("#ai-open:not([disabled])").waitFor({ state: "attached" });
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
    assert.deepEqual(failures, []);
    console.log(
      engine,
      "shared-document TOC, keyboard activation, page/scroll tracking, history, reload, bookmarks, inline anchors, palm reading and stable PDF outline passed",
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
