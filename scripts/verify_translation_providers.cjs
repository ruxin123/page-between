// An isolated server must route Google and model requests to controlled local providers.
const assert = require("node:assert/strict"),
  { webkit, chromium } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
async function api(path, body) {
  const r = await fetch(
    base + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const d = await r.json();
  assert(r.ok, d.error);
  return d;
}
(async () => {
  const browser = await { webkit, chromium }[engine].launch(),
    page = await browser.newPage({ viewport: { width: 1380, height: 1000 } }),
    errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/translation/start"))
      requests.push(r.postDataJSON());
  });
  const originalSettings = await api("/api/settings"),
    original = originalSettings.services.translation;
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
  const config = () => page.locator("#settings-translation form");
  async function select() {
    await page.evaluate(() => {
      const node = document.querySelector("#chapter-body p").firstChild,
        r = document.createRange();
      r.setStart(node, 0);
      r.setEnd(node, Math.min(node.length, 24));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.locator("#translate-selection").click();
  }
  try {
    await page.goto(base + "/#/settings/translation");
    await config().waitFor();
    await config().locator('[name="provider"]').selectOption("google");
    assert(!(await config().locator("[data-ai-options]").isVisible()));
    await config().locator('[type="submit"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector("#settings-translation [data-result]").dataset
          .kind === "success",
    );
    assert.equal((await api("/api/translation/status")).provider, "google");
    await page.goto(base + "/#/read/demo-b");
    await ready();
    await select();
    await result();
    assert.equal(requests.at(-1).provider, "google");
    assert(await page.locator("#translation-query").isHidden());
    await page.locator("#translation-edit").click();
    const md =
      "## Definition\n\nAn **injective** map $f:A\\to B$.\n\n- Each input has one output.\n\n| Input | Output |\n| --- | --- |\n| one | $x^2$ |\n\n`const x = 1`";
    await page.locator("#translation-query").fill(md);
    await page.locator("#translation-edit").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#translation-original-preview math") &&
        document.querySelector("#translation-original-preview table"),
    );
    await page.locator("#translation-retry").click();
    await result();
    for (const tag of ["h2", "strong", "math", "table", "ul", "code"])
      assert(await page.locator("#translation-output " + tag).count(), tag);
    await page.locator("#translation-provider").selectOption("ai");
    await result();
    assert.equal(requests.at(-1).provider, "ai");
    await page.locator("#translation-retry").click();
    await result();
    assert.equal(requests.at(-1).force, true);
    await page.locator("#translation-close").click();
    await page.goto(base + "/#/settings/translation");
    await config().waitFor();
    await config().locator('[name="provider"]').selectOption("ai");
    await config().locator('[name="useChatModel"]').uncheck();
    assert(await config().locator("[data-translation-model]").isVisible());
    await config()
      .locator('[name="baseUrl"]')
      .fill(originalSettings.services.ai.baseUrl);
    await config().locator('[name="model"]').fill("translation-only-model");
    await config().locator('[type="submit"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector("#settings-translation [data-result]").dataset
          .kind === "success",
    );
    let saved = await api("/api/settings");
    assert.equal(saved.services.translation.model, "translation-only-model");
    assert.equal(saved.services.ai.model, originalSettings.services.ai.model);
    assert.equal(saved.services.translation.useChatModel, false);
    await page.goto(base + "/#/read/demo-b");
    await ready();
    await select();
    await result();
    assert(
      (
        await page.locator("#translation-provider").getAttribute("title")
      ).includes("translation-only-model"),
    );
    await page.locator("#translation-close").click();
    await page.route("**/api/translation/status", (r) =>
      r.fulfill({
        json: { provider: "ai", aiReady: false, useChatModel: true },
      }),
    );
    const before = requests.length;
    await select();
    await page.waitForFunction(() =>
      document
        .querySelector("#translation-status")
        .textContent.includes("尚未配置"),
    );
    assert.equal(requests.length, before);
    assert(await page.locator("#translation-submit").isDisabled());
    assert(await page.locator("#translation-settings").isVisible());
    await page.locator("#translation-provider").selectOption("google");
    await result();
    assert.equal(requests.at(-1).provider, "google");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        providers: ["ai", "google"],
        checks: [
          "settings/default",
          "dedicated-model",
          "inheritance",
          "unconfigured-disabled",
          "google-independent",
          "window-switch",
          "forced-retry",
          "original-and-translated-markdown",
          "math-code-preserved",
        ],
        errors,
      }),
    );
  } finally {
    await api("/api/settings/save", {
      service: "translation",
      config: {
        baseUrl: original.baseUrl,
        model: original.model,
        key: "",
        provider: original.provider,
        useChatModel: original.useChatModel,
      },
    });
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
