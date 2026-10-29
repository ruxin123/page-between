// Anonymous fixtures use the production renderer and formula matcher; no cloud calls.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { webkit, chromium } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
const fixtures = JSON.parse(
  execFileSync(
    process.env.PYTHON || "python3",
    [
      "-c",
      String.raw`
import base64, io, json
from unittest.mock import patch
from PIL import Image, ImageDraw
import ai_tutor, translation
book = {"id":"original-formulas", "type":"pdf", "pages":1, "title":"原创公式"}
raw = r"Before $x+\overline{y$ after."
image = Image.new("RGB", (240, 48), "white")
draw = ImageDraw.Draw(image)
draw.text((12, 14), "x + y", fill="black")
draw.line((36, 10, 44, 10), fill="black")
png = io.BytesIO(); image.save(png, format="PNG")
crop = {"src":"data:image/png;base64,"+base64.b64encode(png.getvalue()).decode(), "width":120}
with patch.object(ai_tutor, "page_enrichment", return_value=[]), patch.object(ai_tutor, "formula_image", return_value=crop):
    preview = ai_tutor.source_preview(book, {"quote":raw, "position":{"index":1}})
values = [
    (raw, raw, ""),
    (r"Compare $\frac{a}{b}+2$ and $\sum_{i=1}^n i$.", r"比较 $\sum_{i=1}^n j$ 与 $\frac{a}{b}+7$。", ""),
    ("Map $a$ to $b$.", "将 $b$ 映射到 $b$。", "ambiguous")
]
result = []
for index, (original, text, _) in enumerate(values):
    fixed = translation.restore_google_math(original, text)
    item = {"id":"f"*32, "provider":"google", "model":"Google 翻译", "translation":fixed["translation"], "formulaWarning":fixed["formulaWarning"], "favorite":False, "detectedLanguage":"en", "html":preview if index == 0 else ai_tutor.answer_html(fixed["translation"], source=True)}
    result.append({"original":original, "preview":preview if index == 0 else ai_tutor.answer_html(original, source=True), "item":item})
print(json.dumps(result))
`,
    ],
    { cwd: require("node:path").resolve(__dirname, ".."), encoding: "utf8" },
  ),
);
(async () => {
  const browser = await { webkit, chromium }[engine].launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          window.copied = text;
        },
      },
    }),
  );
  let current = fixtures[0];
  await page.route("**/api/translation/status", (route) =>
    route.fulfill({ json: { provider: "google", aiReady: false } }),
  );
  await page.route("**/api/translation/preview", (route) =>
    route.fulfill({ json: { html: current.preview } }),
  );
  await page.route("**/api/translation/start", (route) =>
    route.fulfill({ json: { status: "ready", result: current.item } }),
  );
  try {
    await page.goto(base + "/?mode=translation");
    await page.waitForFunction(() => window.readerTranslationReceive);
    for (let index = 0; index < fixtures.length; index++) {
      current = fixtures[index];
      await page.evaluate(
        (original) =>
          window.readerTranslationReceive({
            context: {
              book: "original-formulas",
              source: { quote: original, position: { index: 1 } },
            },
          }),
        current.original,
      );
      await page.locator("#translation-result").waitFor({ state: "visible" });
      await page.waitForFunction(
        (text) => document.querySelector("#translation-query").value === text,
        current.original,
      );
      await page.locator("#translation-copy-original").click();
      assert.equal(await page.evaluate(() => window.copied), current.original);
      await page.locator("#translation-copy").click();
      assert.equal(
        await page.evaluate(() => window.copied),
        current.item.translation,
      );
      if (index === 0) {
        for (const width of [320, 680]) {
          await page.setViewportSize({ width, height: 800 });
          for (const selector of [
            "#translation-original-preview img",
            "#translation-output img",
          ]) {
            await page.locator(selector).waitFor();
            assert(
              await page
                .locator(selector)
                .evaluate((img) => img.complete && img.naturalWidth > 0),
            );
          }
          assert(
            !(await page.locator("#translation-output").textContent()).includes(
              "暂无法显示",
            ),
          );
        }
      } else if (index === 1) {
        assert.equal(current.item.formulaWarning, "");
        assert.equal(await page.locator("#translation-output math").count(), 2);
      } else {
        assert(
          (await page.locator("#translation-output").textContent()).includes(
            "映射到",
          ),
        );
        assert(
          (await page.locator("#translation-status").textContent()).includes(
            "无法可靠对应",
          ),
        );
        assert.equal(await page.locator("#translation-output math").count(), 2);
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        checks: [
          "original-image-fallback",
          "narrow-window",
          "raw-copy-preserved",
          "reordered-edited-formulas",
          "ambiguous-prose-kept",
        ],
        passed: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
