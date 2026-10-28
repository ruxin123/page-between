// Run against an isolated sample library and a controlled local provider.
const assert = require("node:assert/strict");
const { webkit, chromium } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
(async () => {
  const browser = await { webkit, chromium }[engine].launch();
  const page = await browser.newPage({
      viewport: { width: 1380, height: 1000 },
    }),
    errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/translation/start"))
      requests.push(r.postDataJSON());
  });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          window.translationCopied = text;
        },
      },
    }),
  );
  const ready = () =>
    page.waitForFunction(
      () =>
        document
          .querySelector("#reading-viewport")
          .getAttribute("aria-busy") === "false" &&
        !document.querySelector("#ai-open").disabled,
    );
  const result = () =>
    page.waitForFunction(
      () =>
        !document.querySelector("#translation-result").hidden &&
        !document.querySelector("#translation-panel").hidden,
    );
  const select = async (type) =>
    page.evaluate((type) => {
      const doc =
        type === "epub"
          ? document.querySelector("#epub-frame").contentDocument
          : document;
      const selector =
        type === "epub"
          ? "p"
          : type === "pdf"
            ? ".textLayer span"
            : "#chapter-body p";
      const element = [...doc.querySelectorAll(selector)].find(
        (e) => e.textContent.trim().length > 8,
      );
      if (!element) throw Error("no selectable text");
      const walk = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walk.nextNode())) {
        if (node.textContent.trim().length > 5) break;
      }
      const range = doc.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(node.length, 30));
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      doc.dispatchEvent(new Event("selectionchange"));
      return range.toString();
    }, type);
  try {
    await page.goto(base + "/#/read/demo-b");
    await ready();
    const text = await select("txt");
    await page.locator("#translate-selection").click();
    await result();
    assert.equal(requests.at(-1).source.quote, text.trim());
    assert.equal(
      await page.locator("#translation-query").inputValue(),
      text.trim(),
    );
    await page.locator("#translation-copy-original").click();
    assert.equal(await page.evaluate(() => translationCopied), text.trim());
    await page.locator("#translation-copy").click();
    assert.equal(
      await page.evaluate(() => translationCopied),
      await page.locator("#translation-output").innerText(),
    );
    await page.locator("#translation-star").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#translation-star")
          .getAttribute("aria-pressed") === "true",
    );
    await page.locator("#translation-recent").click();
    await page.locator(".translation-history-item").first().waitFor();
    assert(await page.locator(".translation-history-item").count());
    const before = requests.length;
    await page.locator(".translation-history-item").first().click();
    await result();
    assert.equal(requests.length, before, "history must not call the model");
    await page.locator("#translation-pin").click();
    await page.locator("#book-title").click();
    assert(await page.locator("#translation-panel").isVisible());
    await page.locator("#translation-pin").click();
    await page.locator("#book-title").click();
    assert(!(await page.locator("#translation-panel").isVisible()));
    await page.locator("#translation-history-open").click();
    await page.locator(".translation-history-item").first().click();
    await result();
    await page.locator("#translation-edit").click();
    await page.locator("#translation-query").fill("SLOW first");
    await page.locator("#translation-submit").click();
    await page.waitForTimeout(100);
    await page.locator("#translation-query").fill("second");
    await page.locator("#translation-submit").click();
    await result();
    await page.waitForTimeout(1800);
    assert.equal(
      await page.locator("#translation-query").inputValue(),
      "second",
    );
    assert(
      !(await page
        .locator("#translation-status")
        .innerText()
        .then((s) => s.includes("失败"))),
    );
    await page
      .locator("#translation-query")
      .fill("An injective map $f:A\\to B$.");
    await page.locator("#translation-submit").click();
    await result();
    assert(await page.locator("#translation-output math").count());
    await page.locator("#translation-copy").click();
    assert(
      (await page.evaluate(() => translationCopied)).includes("$f:A\\to B$"),
    );
    await page.locator("#translation-to").selectOption("en");
    await result();
    assert.equal(requests.at(-1).targetLanguage, "en");
    await page.locator("#translation-query").fill("term");
    await page.locator("#translation-submit").click();
    await result();
    await page.locator("#translation-output").evaluate((node) => {
      const r = document.createRange();
      r.selectNodeContents(node);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      const e = new ClipboardEvent("copy", {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(e);
      window.copyHijacked = e.defaultPrevented;
    });
    assert.equal(
      await page.evaluate(() => copyHijacked),
      false,
      "reading selection must not hijack copying translation",
    );
    await page.screenshot({ path: `qa/translation/translation-${engine}.png` });
    await page.locator("#translation-close").click();
    for (const [id, type] of [
      ["demo-a", "epub"],
      ["demo-c", "pdf"],
    ]) {
      await page.goto(base + "/#/read/" + id);
      await ready();
      if (type === "pdf")
        await page.waitForFunction(() =>
          document.querySelector(".textLayer span"),
        );
      const selected = await select(type);
      await page.locator("#translate-selection").click();
      await result();
      assert(requests.at(-1).source.quote.trim());
      assert.equal(requests.at(-1).book, id);
      assert(selected.trim());
      await page.locator("#translation-close").click();
    }
    await page.goto(base + "/?mode=palm&book=demo-b");
    await ready();
    await select("txt");
    await page.locator("#translate-selection").click();
    await result();
    assert.equal(requests.at(-1).book, "demo-b");
    await page.locator("#translation-close").click();
    await select("txt");
    await page.waitForTimeout(120);
    await page.keyboard.press("Meta+Shift+T");
    await result();
    await page.locator("#translation-edit").click();
    await page.locator("#translation-query").fill("SLOW cancellation");
    await page.locator("#translation-submit").click();
    await page.waitForTimeout(100);
    await page.locator("#translation-stop").click();
    assert(
      (await page.locator("#translation-status").innerText()).includes("停止"),
    );
    await page.waitForTimeout(1800);
    assert(!(await page.locator("#translation-result").isVisible()));
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        selectionTypes: ["txt", "epub", "pdf", "palm"],
        checks:
          "source/copy/formula/history/favorite/languages/pin/dismiss/stale/cancel/shortcut",
        requests: requests.length,
        errors,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
