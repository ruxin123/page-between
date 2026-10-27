// Original formulas exercise mixed MinerU classifications and shared row alignment.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["chromium", "webkit"].includes(engine));
const preview = execFileSync(
  process.env.PYTHON || "python3",
  [
    "-c",
    String.raw`
import ai_tutor as tutor,json
from unittest.mock import patch
texts=[r'D_1=\{x\in D\mid x\text{ has a predecessor}\};',
       r'$D_2=\{x\in D\mid x\text{ has no predecessor}\}$;',r'D_3=\emptyset.']
payload={'quote':'\n\n'.join(texts),'position':{'index':1}}
before=json.dumps(payload)
with patch.object(tutor,'page_enrichment',return_value=[{'type':t,'text':s} for t,s in zip(['equation','text','equation'],texts)]):
 print(tutor.source_preview({'id':'original','title':'Original math sample','type':'pdf','pages':1},payload))
assert json.dumps(payload)==before
`,
  ],
  { encoding: "utf8" },
);
(async () => {
  const browser = await { chromium, webkit }[engine].launch();
  let cases = 0;
  try {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 900 },
    });
    await page.route(base + "/formula-layout-check.html", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          '<!doctype html><link rel="stylesheet" href="/layout.css"><main style="margin:32px"><div id="ai-quote" class="ai-answer">' +
          preview +
          "</div></main>",
      }),
    );
    await page.goto(base + "/formula-layout-check.html");
    for (const width of [320, 720])
      for (const theme of ["paper", "sage", "blue", "night"]) {
        const info = await page.evaluate(
          ({ width, theme }) => {
            document.body.dataset.theme = theme;
            const host = document.querySelector("main");
            host.style.width = width + "px";
            const group = document.querySelector(".source-equations");
            const rows = [...group.querySelectorAll('math[display="block"]')];
            return {
              left: rows.map(
                (row) => row.querySelector("msub").getBoundingClientRect().left,
              ),
              annotations: rows.map(
                (row) =>
                  row.querySelector("annotation").getBoundingClientRect().width,
              ),
              width: group.getBoundingClientRect().width,
            };
          },
          { width, theme },
        );
        assert.equal(info.left.length, 3);
        assert(
          Math.max(...info.left) - Math.min(...info.left) < 1,
          JSON.stringify(info),
        );
        assert(
          info.annotations.every((width) => width === 0),
          "TeX annotation must stay hidden",
        );
        assert(
          info.width <= width + 1,
          "Long formula groups must scroll within the quote",
        );
        cases++;
      }
    console.log(
      JSON.stringify({
        engine,
        cases,
        mixedClassification: true,
        commonLeftEdge: true,
        boundedWidth: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
