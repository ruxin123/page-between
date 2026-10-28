// Use an isolated library; provider requests must remain local to the test.
const assert = require("node:assert/strict");
const { webkit, chromium } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
(async () => {
  const browser = await { webkit, chromium }[engine].launch(),
    page = await browser.newPage({ viewport: { width: 1380, height: 1000 } }),
    errors = [],
    previews = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/ai/preview")) previews.push(r.postDataJSON());
  });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text) => (window.copied = text) },
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
  async function select(type) {
    await page.evaluate((type) => {
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
      const element =
        type === "pdf"
          ? [...doc.querySelectorAll(".textLayer")].find(
              (e) => e.textContent.trim().length > 3,
            )
          : [...doc.querySelectorAll(selector)].find(
              (e) => e.textContent.trim().length > 2,
            );
      if (!element) throw Error("No selection text");
      const walk = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT),
        nodes = [];
      let node;
      while ((node = walk.nextNode()))
        if (node.textContent.trim().length) nodes.push(node);
      if (!nodes.length) throw Error("No selection nodes");
      const range = doc.createRange();
      range.setStart(nodes[0], 0);
      let remaining = 24;
      for (const node of nodes) {
        range.setEnd(node, Math.min(node.length, remaining));
        remaining -= Math.min(node.length, remaining);
        if (!remaining) break;
      }
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(range);
      doc.dispatchEvent(new Event("selectionchange"));
    }, type);
    await page.locator("#selection-toolbar").waitFor();
  }
  try {
    for (const [id, type, mode] of [
      ["demo-b", "txt", "main"],
      ["demo-a", "epub", "main"],
      ["demo-c", "pdf", "main"],
      ["demo-e", "pdf", "main"],
      ["demo-b", "txt", "palm"],
    ]) {
      await page.goto(
        base + (mode === "palm" ? "/?mode=palm&book=" + id : "/#/read/" + id),
      );
      await ready();
      if (type === "pdf")
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".textLayer")].some(
            (e) => e.textContent.trim().length > 3,
          ),
        );
      await select(type);
      await page.locator("#copy-selection").click();
      const expected = await page.evaluate(() => copied);
      await page.evaluate(() => {
        window.keyboardCopy = null;
        window.copied = null;
        const record = (e) =>
          (window.keyboardCopy = e.clipboardData.getData("text/plain"));
        document.addEventListener("copy", record);
        document
          .querySelector("#epub-frame")
          .contentDocument?.addEventListener("copy", record);
      });
      await page.keyboard.press("Meta+C");
      await page.waitForFunction(
        () => window.keyboardCopy !== null || window.copied !== null,
      );
      assert.equal(await page.evaluate(() => keyboardCopy ?? copied), expected);
      await page.keyboard.press("Meta+Shift+A");
      await page.locator("#question-panel").waitFor();
      await page.waitForFunction(() =>
        document.querySelector("#ai-quote").textContent.trim(),
      );
      assert.equal(previews.at(-1).quote, expected);
      await page.locator("#question-close").click();
      await select(type);
      await page.keyboard.press("Meta+Shift+T");
      await page.waitForFunction(
        () =>
          !document.querySelector("#translation-result").hidden &&
          !document.querySelector("#translation-panel").hidden,
      );
      assert.equal(
        await page.locator("#translation-query").inputValue(),
        expected,
      );
      const sizes = await page.evaluate(() => {
        const a = document.querySelector("#translation-original-preview"),
          b = document.querySelector("#translation-output");
        return {
          original: getComputedStyle(a).fontSize,
          translation: getComputedStyle(b).fontSize,
          lineA: getComputedStyle(a).lineHeight,
          lineB: getComputedStyle(b).lineHeight,
        };
      });
      assert.equal(sizes.original, sizes.translation);
      assert.equal(sizes.lineA, sizes.lineB);
      assert.equal(
        (await page.locator("#translation-status").innerText()).trim(),
        "",
      );
      assert(await page.locator("#translation-recent").isHidden());
      assert(await page.locator("#translation-star").isHidden());
      assert(await page.locator("#translation-source").isHidden());
      assert(await page.locator("#translation-ask").isHidden());
      assert(await page.locator("#translation-submit").isHidden());
      await page.keyboard.press("Meta+C");
      assert((await page.evaluate(() => copied)).trim());
      await page.locator("#translation-menu summary").click();
      assert(await page.locator("#translation-source").isVisible());
      await page.locator("#translation-menu summary").click();
      await page.locator("#translation-close").click();
      console.log(
        engine,
        type,
        mode,
        "copy / ask / translate keyboard actions; matching type and compact default",
      );
    }
    await page.goto(base + "/#/settings/ai");
    await page.locator("#settings-ai form").waitFor();
    assert(!(await page.locator("#settings-ai .service-help p").isVisible()));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
