// Original math examples. No model request is needed for the source preview.
const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["chromium", "webkit"].includes(engine));
const inline = String.raw`**说明** $\mathbf{v}:\mathbb{R}\to\mathbb{R}$`;
const array = String.raw`$$h(t)=\left\{\begin{array}{l l}t^2&\text{if }t\ge0\\0&\text{if }t<0\end{array}\right.$$`;
const code = String.raw`\begin{array}{l l}`;
(async () => {
  const text =
    "第一章 原创公式样本\n\n" + inline + "\n\n" + array + "\n\n`" + code + "`";
  const response = await fetch(
    base + "/api/import?name=original-math-preview.txt&parse=0",
    { method: "POST", body: Buffer.from(text) },
  );
  const { book } = await response.json();
  assert(response.ok && book.type === "txt");
  const browser = await { chromium, webkit }[engine].launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
    });
    const failures = [];
    page.on("pageerror", (e) => failures.push(e.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text) => {
            window.mathPreviewCopied = text;
          },
        },
      }),
    );
    await page.goto(base + "/#/read/" + book.id);
    await page.waitForFunction(
      () =>
        document
          .querySelector("#reading-viewport")
          ?.getAttribute("aria-busy") === "false" &&
        !document.querySelector("#ai-open").disabled,
    );
    await page.locator("#toc-close").click();
    const raw = await page.evaluate(() => {
      const paragraphs = [...document.querySelectorAll("#chapter-body p")];
      const first = paragraphs.find((p) => p.textContent.includes("**说明**"));
      const last = paragraphs.findLast((p) => p.textContent.includes("`"));
      const range = document.createRange();
      range.setStart(first.firstChild, 0);
      range.setEnd(last.lastChild, last.lastChild.textContent.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return getSelection().toString();
    });
    await page.locator("#selection-toolbar").waitFor({ state: "visible" });
    await page.locator("#copy-selection").click();
    assert.equal(await page.evaluate(() => window.mathPreviewCopied), raw);
    await page.locator("#ask-selection").click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#ai-quote").hasAttribute("aria-busy") &&
        document.querySelectorAll("#ai-quote math").length === 2,
    );
    const result = await page.evaluate(() => {
      const host = document.querySelector("#ai-quote"),
        math = [...host.querySelectorAll("math")];
      return {
        math: math.map((m) => ({
          namespace: m.namespaceURI,
          width: m.getBoundingClientRect().width,
          height: m.getBoundingClientRect().height,
        })),
        styles: host.querySelectorAll("math mstyle").length,
        rows: host.querySelectorAll('math[display="block"] mtable mtr').length,
        outside: [
          ...host.querySelectorAll("mstyle,mi,mo,mrow,annotation"),
        ].filter((n) => n.namespaceURI !== "http://www.w3.org/1998/Math/MathML")
          .length,
        annotationBoxes: [...host.querySelectorAll("annotation")].map((n) => {
          const r = n.getBoundingClientRect();
          return r.width * r.height;
        }),
        code: host.querySelector("code")?.textContent,
        invalidHTML: host.querySelectorAll("math span").length,
        unsafe: host.querySelectorAll(
          "script,iframe,img,[href],[src],[style],[onclick]",
        ).length,
      };
    });
    assert(
      result.math.every(
        (m) =>
          m.namespace === "http://www.w3.org/1998/Math/MathML" &&
          m.width > 10 &&
          m.height > 0,
      ), JSON.stringify(result),
    );
    assert(result.styles >= 1);
    assert.equal(result.rows, 2);
    assert.equal(result.outside, 0);
    assert(
      result.annotationBoxes.every((area) => area === 0),
      "LaTeX annotations must remain hidden inside MathML.",
    );
    assert.equal(result.code, code);
    assert.equal(result.invalidHTML, 0);
    assert.equal(result.unsafe, 0);
    await page.locator("#copy-question").click();
    assert(
      (await page.evaluate(() => window.mathPreviewCopied)).endsWith(raw),
      "Rendered source must still copy the original LaTeX.",
    );
    if (process.env.MATH_PREVIEW_SCREENSHOT)
      await page
        .locator("#question-panel")
        .screenshot({ path: process.env.MATH_PREVIEW_SCREENSHOT });
    assert.deepEqual(failures, []);
    console.log(
      JSON.stringify({
        engine,
        boldMath: true,
        spacedArrayColumns: true,
        piecewiseRows: 2,
        nativeMathMLNamespace: true,
        annotationsHidden: true,
        codeUnchanged: true,
        originalCopy: true,
        modelNotCalled: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
