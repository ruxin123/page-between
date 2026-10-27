// Isolated --demo server; native bridge messages are captured without sending to a model.
const assert = require("node:assert/strict");
const { webkit, chromium } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
(async () => {
  const browser = await { webkit, chromium }[engine].launch();
  try {
    const reader = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    });
    await reader.addInitScript(() => {
      window.nativeMessages = [];
      window.webkit = {
        messageHandlers: {
          appNative: { postMessage: (message) => nativeMessages.push(message) },
        },
      };
    });
    await reader.goto(base + "/#/read/demo-b");
    await reader.waitForFunction(
      () =>
        document
          .querySelector("#reading-viewport")
          ?.getAttribute("aria-busy") === "false" &&
        !document.querySelector("#ai-open").disabled,
    );
    await reader.locator('#toc-list [data-index="2"]').click();
    await reader.waitForFunction(
      () =>
        document.querySelector("#page-label").dataset.chapter === "2" &&
        !document.querySelector("#ai-open").disabled,
    );
    await reader.evaluate(() => {
      const node = document.querySelector("#chapter-body p").firstChild,
        range = document.createRange();
      range.setStart(node, 3);
      range.setEnd(node, 25);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await reader.locator("#selection-toolbar").waitFor({ state: "visible" });
    await reader.locator("#ask-selection").click();
    const request = await reader.evaluate(() =>
      nativeMessages.findLast((m) => m.action === "tutor"),
    );
    assert(request?.context?.source?.quote);
    assert(
      await reader.locator("#question-panel").isHidden(),
      "The native reader must not retain an obstructing inline panel",
    );
    const question = await browser.newPage({
      viewport: { width: 500, height: 720 },
    });
    await question.addInitScript(() => {
      window.nativeMessages = [];
      window.copied = "";
      window.webkit = {
        messageHandlers: {
          tutorNative: {
            postMessage: (message) => nativeMessages.push(message),
          },
        },
      };
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text) => (window.copied = text) },
      });
    });
    await question.goto(base + "/?mode=tutor");
    await question.waitForFunction(() => window.readerTutorReceive);
    await question.evaluate((request) => readerTutorReceive(request), request);
    await question.waitForFunction(
      () =>
        !document.querySelector("#ai-quote").hasAttribute("aria-busy") &&
        document.querySelector("#ai-quote").innerText.trim(),
    );
    assert(
      (await question.locator("#ai-quote").innerText()).includes(
        request.context.source.quote,
      ),
    );
    assert(await question.locator("#workspace").isHidden());
    assert(await question.locator("#reader").isHidden());
    await question.locator("#question-input").fill("Original unsent draft");
    await question.locator("#copy-question").click();
    const copied = await question.evaluate(() => window.copied);
    assert(
      copied.includes(request.context.source.quote) &&
        copied.includes("Original unsent draft"),
    );
    await question.locator("#question-close").click();
    assert(
      await question.evaluate(() =>
        nativeMessages.some((m) => m.action === "close"),
      ),
    );
    await question.evaluate((request) => readerTutorReceive(request), request);
    assert.equal(
      await question.locator("#question-input").inputValue(),
      "Original unsent draft",
    );
    await question.locator("#question-source").click();
    const source = await question.evaluate(() =>
      nativeMessages.findLast((m) => m.action === "source"),
    );
    assert.equal(source.book, request.context.book);
    assert.deepEqual(source.position, request.context.source.position);
    assert(
      await question.locator("#question-panel").isVisible(),
      "Source navigation must leave the independent question window available",
    );
    await reader.goto(base + "/#/read/demo-c");
    await reader.waitForFunction(
      () =>
        document
          .querySelector("#reading-viewport")
          ?.getAttribute("aria-busy") === "false" &&
        !document.querySelector("#ai-open").disabled,
    );
    await reader.evaluate(
      (source) => readerOpenTutorSource(source.book, source.position),
      source,
    );
    assert.equal(
      await reader.evaluate(() => location.hash),
      "#/read/" + source.book,
    );
    assert.equal(
      await reader.locator("#page-label").getAttribute("data-chapter"),
      String(source.position.index),
    );
    await reader.waitForTimeout(3100);
    assert.equal(
      await reader.locator("#page-label").getAttribute("data-chapter"),
      "2",
    );
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(
      state.positions[source.book].index,
      2,
      "Returning from a separate window must persist the target and not bounce back",
    );
    await question.evaluate(
      (request) => readerTutorReceive({ ...request, history: true }),
      request,
    );
    await question.waitForFunction(
      () =>
        !document
          .querySelector("#ai-history-list")
          .textContent.includes("正在读取"),
    );
    await question.locator("#ai-history-toggle").click();
    assert(await question.locator("#question-input").isVisible());
    for (const size of [
      { width: 360, height: 480 },
      { width: 760, height: 900 },
    ]) {
      await question.setViewportSize(size);
      const box = await question.locator("#question-panel").boundingBox();
      assert.equal(Math.round(box.width), size.width);
      assert.equal(Math.round(box.height), size.height);
      const submit = await question.locator("#ai-submit").boundingBox();
      assert(
        submit && submit.y >= 0 && submit.y + submit.height <= size.height,
      );
    }
    assert(
      !(await question.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some(
            (r) =>
              r.name.includes("pdf.worker") || r.name.includes("/app-v2.mjs"),
          ),
      )),
    );
    console.log(
      JSON.stringify({
        engine,
        selectionForwarded: true,
        noInlineObstruction: true,
        quoteAndRawCopy: true,
        draftPreserved: true,
        crossBookSourceReturn: true,
        history: true,
        windowSizes: 2,
        readerNotLoadedInTutor: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
