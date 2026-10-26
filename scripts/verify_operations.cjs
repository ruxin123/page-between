// Use an isolated demo library: these checks intentionally delay writes and change metadata.
const assert = require("node:assert/strict");
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
let titles = {};
async function ready(p, id) {
  await p.waitForFunction(
    ({ id, title }) =>
      document.querySelector("#reading-viewport")?.getAttribute("aria-busy") ===
        "false" &&
      !document.querySelector("#ai-open").disabled &&
      document.querySelector("#book-title").textContent === title &&
      location.hash.endsWith("/" + id),
    { id, title: titles[id] },
  );
}
(async () => {
  assert.equal((await api("/api/formats")).demo, true);
  const initial = await api("/api/library"),
    state = await api("/api/state");
  titles = Object.fromEntries(
    initial.books.map((book) => [book.id, book.title]),
  );
  const browser = await { chromium, webkit }[engine].launch();
  let release = () => {};
  try {
    const p = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base + "/#/read/demo-b");
    await ready(p, "demo-b");
    // A second click/shortcut while the first save is pending cannot create another UUID.
    let held = new Promise((r) => (release = r)),
      adds = 0;
    await api("/api/state", { bookmarks: [] });
    await p.reload();
    await ready(p, "demo-b");
    await p.route("**/api/state", async (r) => {
      const d =
        r.request().method() === "POST" ? r.request().postDataJSON() : {};
      if (d.bookmarkChanges?.add) {
        adds++;
        await held;
      }
      await r.continue();
    });
    await p.locator("#bookmark-button").click();
    await p.waitForFunction(
      () => document.querySelector("#bookmark-button").disabled,
    );
    await p.evaluate(() => document.querySelector("#bookmark-button").click());
    await p.keyboard.press("Meta+b");
    release();
    await p.waitForFunction(
      () => !document.querySelector("#bookmark-button").disabled,
    );
    assert.equal(adds, 1);
    assert.equal(
      (await api("/api/state")).bookmarks.filter((m) => m.book === "demo-b")
        .length,
      1,
    );
    await p.unroute("**/api/state");
    // Failed writes release the same controls and preserve a usable reader.
    await p.route("**/api/state", async (r) => {
      if (
        r.request().method() === "POST" &&
        r.request().postDataJSON()?.bookmarkChanges
      )
        await r.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Controlled write failure" }),
        });
      else await r.continue();
    });
    await p.locator("#bookmark-button").click();
    await p.waitForFunction(
      () => !document.querySelector("#bookmark-button").disabled,
    );
    assert.equal(
      (await api("/api/state")).bookmarks.filter((m) => m.book === "demo-b")
        .length,
      1,
    );
    await p.unroute("**/api/state");
    // An in-flight import owns a stable batch, even if the dialog is closed and reopened.
    await p.goto(base + "/#/library");
    await p.locator("#import-open").click();
    await p.locator("#file-input").setInputFiles({
      name: "original-batch-first.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("第一章 原创样本\n第一批文件。"),
    });
    const calls = [];
    held = new Promise((r) => (release = r));
    await p.route("**/api/import?**", async (r) => {
      calls.push(new URL(r.request().url()).searchParams.get("name"));
      await held;
      await r.continue();
    });
    await p.locator("#import-submit").click();
    await p.waitForFunction(
      () => document.querySelector("#file-input").disabled,
    );
    await p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File(["第二批文件。"], "original-batch-second.txt", {
          type: "text/plain",
        }),
      );
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dt });
      document.querySelector("#drop-zone").dispatchEvent(event);
      document.querySelector("#import-submit").click();
    });
    await p.keyboard.press("Escape");
    await p.locator("#import-open").click();
    assert.equal(await p.locator(".import-file").count(), 1);
    assert.equal(await p.locator("#import-submit").isDisabled(), true);
    release();
    await p.waitForFunction(
      () => !document.querySelector("#file-input").disabled,
    );
    assert.deepEqual(calls, ["original-batch-first.txt"]);
    await p.locator("#file-input").setInputFiles({
      name: "original-batch-second.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("第一章 原创样本\n新的批次。"),
    });
    assert.equal(await p.locator(".import-file").count(), 1);
    await p.locator("#import-submit").click();
    await p.waitForFunction(
      () => !document.querySelector("#file-input").disabled,
    );
    assert.deepEqual(calls, [
      "original-batch-first.txt",
      "original-batch-second.txt",
    ]);
    await p.unroute("**/api/import?**");
    await p.locator("#file-input").setInputFiles([
      {
        name: "original-retry-a.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("原创成功文件。"),
      },
      {
        name: "original-retry-b.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("原创重试文件。"),
      },
    ]);
    const retryCalls = [];
    let failOnce = true;
    await p.route("**/api/import?**", async (r) => {
      const name = new URL(r.request().url()).searchParams.get("name");
      retryCalls.push(name);
      if (name === "original-retry-b.txt" && failOnce) {
        failOnce = false;
        await r.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Controlled import outage" }),
        });
      } else await r.continue();
    });
    await p.locator("#import-submit").click();
    await p.waitForFunction(
      () => !document.querySelector("#file-input").disabled,
    );
    assert.equal(await p.locator(".import-file").count(), 1);
    assert.match(await p.locator("#import-submit").textContent(), /重试 1/);
    await p.locator("#import-submit").click();
    await p.waitForFunction(
      () => !document.querySelector("#file-input").disabled,
    );
    assert.deepEqual(retryCalls, [
      "original-retry-a.txt",
      "original-retry-b.txt",
      "original-retry-b.txt",
    ]);
    await p.unroute("**/api/import?**");
    await p.keyboard.press("Escape");
    // Metadata belongs to the source book, not whichever book is opened after save.
    await p.goto(base + "/#/read/demo-b");
    await ready(p, "demo-b");
    await p.locator("#book-options").click();
    await p.locator("#book-name").fill("Original metadata save sample");
    held = new Promise((r) => (release = r));
    const saves = [];
    await p.route("**/api/state", async (r) => {
      if (r.request().method() === "POST") await held;
      await r.continue();
    });
    await p.route("**/api/books/*", async (r) => {
      if (r.request().method() === "POST")
        saves.push(new URL(r.request().url()).pathname);
      await r.continue();
    });
    await p.locator("#book-save").click();
    await p.waitForFunction(
      () => document.querySelector("#book-save").disabled,
    );
    await p.keyboard.press("Escape");
    await p.evaluate(() => (location.hash = "#/read/demo-a"));
    await ready(p, "demo-a");
    await p.locator("#book-options").click();
    assert.equal(
      await p.locator("#book-dialog").evaluate((n) => n.open),
      false,
    );
    release();
    await p.waitForFunction(
      () => !document.querySelector("#book-save").disabled,
    );
    assert.deepEqual(saves, ["/api/books/demo-b"]);
    assert.equal(
      (await api("/api/library")).books.find((b) => b.id === "demo-a").title,
      initial.books.find((b) => b.id === "demo-a").title,
    );
    await p.locator("#book-options").click();
    assert.equal(await p.locator("#book-dialog").evaluate((n) => n.open), true);
    await p.keyboard.press("Escape");
    await p.unroute("**/api/state");
    // A slow search in another book must not expose the previous book's links.
    await p.locator("#knowledge-open").click();
    await p.locator("#knowledge-previous").uncheck();
    await p.locator("#knowledge-query").fill("清晨");
    await p.locator("#knowledge-form").evaluate((form) => form.requestSubmit());
    await p.waitForFunction(() => document.querySelector(".knowledge-result"));
    await p.evaluate(() => {
      window.previousSearchJump = document.querySelector(
        "[data-knowledge-jump]",
      );
    });
    await p.locator("#knowledge-close").click();
    titles["demo-b"] = "Original metadata save sample";
    await p.evaluate(() => (location.hash = "#/read/demo-b"));
    await ready(p, "demo-b");
    held = new Promise((r) => (release = r));
    await p.route("**/api/index/search", async (r) => {
      await held;
      await r.continue();
    });
    await p.locator("#knowledge-open").click();
    await p.waitForFunction(
      () =>
        document
          .querySelector("#knowledge-results")
          .getAttribute("aria-busy") === "true",
    );
    assert.equal(await p.locator(".knowledge-result").count(), 0);
    const chapter = await p.locator("#page-label").getAttribute("data-chapter");
    await p.evaluate(() => window.previousSearchJump.click());
    assert.equal(
      await p.locator("#page-label").getAttribute("data-chapter"),
      chapter,
    );
    release();
    await p.waitForFunction(
      () =>
        document
          .querySelector("#knowledge-results")
          .getAttribute("aria-busy") !== "true",
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        bookmarkDoubleInput: true,
        failedWriteUnlocks: true,
        stableImportBatch: true,
        reopenDuringImport: true,
        newBatchOnly: true,
        retryFailedFilesOnly: true,
        metadataSourceBound: true,
        switchBookDuringSave: true,
        crossBookSearchResultsCleared: true,
      }),
    );
  } finally {
    release();
    await browser.close();
    await api("/api/state", { bookmarks: state.bookmarks || [] });
    const b = initial.books.find((b) => b.id === "demo-b");
    await api("/api/books/demo-b", { title: b.title, shelf: b.shelf });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
