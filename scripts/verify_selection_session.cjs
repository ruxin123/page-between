// Isolated sample library only; popups must keep their source selection usable.
const assert = require("node:assert/strict"),
  { webkit, chromium } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
(async () => {
  const browser = await { webkit, chromium }[engine].launch();
  let checks = 0;
  const errors = [];
  async function exercise(detached) {
    const page = await browser.newPage({
      viewport: { width: 1380, height: 1000 },
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((detached) => {
      window.sent = [];
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text) => (window.copied = text) },
      });
      if (detached)
        window.webkit = {
          messageHandlers: {
            appNative: { postMessage: (request) => window.sent.push(request) },
          },
        };
    }, detached);
    const ready = () =>
      page.waitForFunction(
        () =>
          document
            .querySelector("#reading-viewport")
            .getAttribute("aria-busy") === "false" &&
          !document.querySelector("#ai-open").disabled,
      );
    const bar = () => page.locator("#selection-toolbar").waitFor();
    async function select(type, second = false) {
      await page.evaluate(
        ({ type, second }) => {
          const doc =
            type === "epub"
              ? document.querySelector("#epub-frame").contentDocument
              : document;
          const roots = [
            ...doc.querySelectorAll(
              type === "epub"
                ? "p"
                : type === "pdf"
                  ? ".textLayer"
                  : "#chapter-body p",
            ),
          ].filter((e) => e.textContent.trim().length > 20);
          const element = roots[second ? Math.min(1, roots.length - 1) : 0];
          if (!element) throw Error("No sample text");
          const walk = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT),
            nodes = [];
          let n;
          while ((n = walk.nextNode())) if (n.textContent.trim()) nodes.push(n);
          const range = doc.createRange();
          range.setStart(
            nodes[0],
            second ? Math.min(3, nodes[0].length - 1) : 0,
          );
          let remaining = second ? 35 : 24;
          for (const node of nodes) {
            const offset = node === nodes[0] ? range.startOffset : 0;
            const length = Math.min(remaining, node.length - offset);
            range.setEnd(node, offset + length);
            remaining -= length;
            if (!remaining) break;
          }
          doc.getSelection().removeAllRanges();
          doc.getSelection().addRange(range);
          doc.dispatchEvent(new Event("selectionchange"));
        },
        { type, second },
      );
      await page.waitForTimeout(120);
      await bar();
    }
    async function outside() {
      const rect = await page.locator("#reading-viewport").boundingBox();
      await page.mouse.click(rect.x + rect.width - 12, rect.y + 60);
    }
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
            (e) => e.textContent.trim().length > 20,
          ),
        );
      await select(type);
      await page.locator("#copy-selection").click();
      const expected = await page.evaluate(() => copied);
      await page.locator("#translate-selection").click();
      if (detached) {
        await page.waitForFunction(() =>
          sent.some((r) => r.action === "translate"),
        );
        await page.evaluate(() => {
          getSelection().removeAllRanges();
          document
            .querySelector("#epub-frame")
            .contentDocument?.getSelection()
            .removeAllRanges();
          window.dispatchEvent(new Event("blur"));
        });
      } else
        await page.waitForFunction(
          () => !document.querySelector("#translation-result").hidden,
        );
      await outside();
      await bar();
      await page.locator("#copy-selection").click();
      assert.equal(await page.evaluate(() => copied), expected);
      await page.locator("#ask-selection").click();
      if (detached) {
        await page.waitForFunction(() =>
          sent.some((r) => r.action === "tutor"),
        );
        const requests = await page.evaluate(() =>
          sent.filter((r) => ["translate", "tutor"].includes(r.action)),
        );
        assert.equal(requests.at(-1).context.source.quote, expected);
        await page.evaluate(() => {
          getSelection().removeAllRanges();
          document
            .querySelector("#epub-frame")
            .contentDocument?.getSelection()
            .removeAllRanges();
          window.dispatchEvent(new Event("focus"));
        });
        await bar();
      } else {
        await page.locator("#question-panel").waitFor();
        await page.locator("#question-close").click();
        await bar();
        await page.keyboard.press("Meta+Shift+T");
        await page.waitForFunction(
          () =>
            !document.querySelector("#translation-panel").hidden &&
            !document.querySelector("#translation-result").hidden,
        );
        assert.equal(
          await page.locator("#translation-query").inputValue(),
          expected,
        );
        await page.locator("#translation-close").click();
        await bar();
      }
      await page.locator("#copy-selection").click();
      assert.equal(await page.evaluate(() => copied), expected);
      await select(type, true);
      await page.locator("#copy-selection").click();
      assert.notEqual(await page.evaluate(() => copied), expected);
      await page.keyboard.press("Escape");
      assert(await page.locator("#selection-toolbar").isHidden());
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(120);
      assert(await page.locator("#selection-toolbar").isHidden());
      await select(type);
      await outside();
      await page.waitForTimeout(150);
      assert(
        await page.locator("#selection-toolbar").isHidden(),
        "a plain selection must still clear normally",
      );
      checks++;
      console.log(
        engine,
        detached ? "native bridge" : "inline",
        type,
        mode,
        "outside dismiss → same source actions; new selection and Escape clear",
      );
    }
    await page.close();
  }
  try {
    await exercise(false);
    await exercise(true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine, checks, errors }));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
