// Use only an isolated --demo reader and a controlled loopback MinerU provider.
// The provider must expose /stats and finish two-page batches; no external service is used.
const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const base = process.argv[2];
const provider = process.argv[3];
const engine = process.argv[4] || "chromium";
assert.ok(
  base && provider,
  "Usage: node scripts/verify_pdf_processing.cjs READER_URL CONTROLLED_PROVIDER_URL chromium|webkit",
);
assert.ok(["chromium", "webkit"].includes(engine));
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(provider).hostname),
);

async function api(path, body) {
  const bytes = Buffer.isBuffer(body);
  const response = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": bytes
              ? "application/octet-stream"
              : "application/json",
          },
          body: bytes ? body : JSON.stringify(body),
        },
  );
  const data = await response.json();
  assert.ok(response.ok, data.error);
  return data;
}
async function wait(predicate, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Timed out: " + label);
}

(async () => {
  assert.equal(
    (await api("/api/formats")).demo,
    true,
    "Use an isolated demo library.",
  );
  const settings = await api("/api/settings");
  assert.equal(
    settings.services.mineru.baseUrl,
    provider + "/api/v4",
    "A controlled provider must be configured before this test can submit.",
  );
  const statsBefore = await (await fetch(provider + "/stats")).json();
  assert.equal(typeof statsBefore.created, "number");
  const initial = await api("/api/library");
  const original = initial.books.find((book) => book.id === "demo-e");
  const bytes = Buffer.from(
    await (await fetch(base + original.originalUrl)).arrayBuffer(),
  );
  const fixture = Buffer.concat([
    bytes,
    Buffer.from(
      `\n% Original preparation verification ${engine} ${Date.now()}\n`,
    ),
  ]);
  const book = (
    await api(
      "/api/import?name=original-preparation-verification.pdf&parse=1",
      fixture,
    )
  ).book;
  await wait(
    async () =>
      (await api("/api/library")).books.find((item) => item.id === book.id)
        .processing !== "pending",
    "initial local outline",
  );
  await api("/api/state", { prefs: { pdfMode: "scroll" } });
  const browser = await { chromium, webkit }[engine].launch({ headless: true });
  const failures = [],
    requests = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("/api/ocr?"))
        requests.push(Number(new URL(request.url()).searchParams.get("page")));
    });
    await page.goto(base + "/#/library");
    await page.locator(`.library-book [data-process="${book.id}"]`).click();
    await page.locator("#cloud-dialog").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector("#local-prepare-all").disabled,
    );
    await page.locator("#local-prepare-all").click();
    await page.locator("#local-prepare-pause").waitFor({ state: "visible" });
    await page.locator("#local-prepare-pause").click();
    await wait(
      async () =>
        (await api("/api/pdf/preparation?book=" + book.id)).local.status ===
        "paused",
      "pause whole-book preparation",
    );
    await wait(
      async () =>
        (await api("/api/pdf/preparation?book=" + book.id)).local.completed >=
        1,
      "persist the in-flight page",
    );
    const paused = await api("/api/pdf/preparation?book=" + book.id);
    assert.ok(paused.local.completed < book.pages);
    await page
      .getByRole("button", { name: "关闭文档处理", exact: true })
      .click();
    await page.goto(base + "/#/read/" + book.id);
    await page.waitForFunction(
      () =>
        document.querySelector('.pdf-page[data-page="1"]')?.dataset.ocr ===
        "ready",
    );
    await page.waitForFunction(
      () =>
        document.querySelector('.pdf-page[data-page="2"]')?.dataset.rendered ===
        "ready",
    );
    await page.locator("#next-button").click();
    await page.waitForFunction(
      () =>
        document.querySelector('.pdf-page[data-page="2"]')?.dataset.ocr ===
        "ready",
    );
    assert.ok(
      requests.includes(2),
      "The pre-rendered second page must request its selection layer.",
    );
    assert.ok(
      (await page.locator('.pdf-page[data-page="2"] .textLayer span').count()) >
        20,
    );
    await wait(async () => {
      const value = await api("/api/pdf/preparation?book=" + book.id);
      return value.local.completed >= Math.min(book.pages, 4);
    }, "reading-ahead preparation");
    const before = await page.evaluate(() => {
      window.pdfVerificationCanvas = document.querySelector(
        '.pdf-page[data-page="2"] canvas',
      );
      return document.querySelector("#reading-viewport").scrollTop;
    });
    await page.locator("#reader-process").click();
    await page.waitForFunction(
      () => !document.querySelector("#cloud-fill").disabled,
    );
    await page.locator("#cloud-fill").click();
    await wait(async () => {
      const state = (await api("/api/pdf/preparation?book=" + book.id)).mineru;
      return state.completed === 2 && state.status === "running";
    }, "first published cloud batch");
    await page.waitForFunction(
      () =>
        document.querySelector("#cloud-progress-count").textContent ===
        "2 / 4 页",
    );
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector('.pdf-page[data-page="2"] canvas') ===
          window.pdfVerificationCanvas,
      ),
      true,
    );
    assert.ok(
      Math.abs(
        (await page
          .locator("#reading-viewport")
          .evaluate((node) => node.scrollTop)) - before,
      ) < 2,
      "Published batches must retain the reading position.",
    );
    await page.locator("#cloud-pause").click();
    await wait(
      async () =>
        (await api("/api/pdf/preparation?book=" + book.id)).mineru.status ===
        "paused",
      "pause cloud job",
    );
    const midway = await api("/api/pdf/preparation?book=" + book.id);
    assert.equal(midway.mineru.completed, 2);
    const pausedStats = await (await fetch(provider + "/stats")).json();
    await page.locator("#cloud-resume").click();
    await wait(
      async () =>
        (await api("/api/pdf/preparation?book=" + book.id)).mineru.completed ===
        4,
      "resume original cloud batches",
    );
    const finalStats = await (await fetch(provider + "/stats")).json();
    assert.equal(finalStats.created, pausedStats.created);
    assert.equal(finalStats.created - statsBefore.created, 2);
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelector('.pdf-page[data-page="2"]')?.dataset.ocr ===
        "ready",
    );
    const restored = await api("/api/pdf/preparation?book=" + book.id);
    assert.equal(restored.local.completed, 4);
    assert.equal(restored.mineru.completed, 4);
    assert.deepEqual(failures, []);
    console.log(
      JSON.stringify({
        engine,
        libraryEntry: true,
        readerEntry: true,
        localWholePause: true,
        subsequentPageSelection: true,
        readingAhead: true,
        separateProgress: true,
        firstCloudBatchVisibleBeforeCompletion: true,
        canvasAndPositionRetained: true,
        pausedCloudPagesRetained: true,
        resumeWithoutDuplicateRemoteTask: true,
        reloadPersistence: true,
        realLocalOCR: true,
        controlledCloudOnly: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
