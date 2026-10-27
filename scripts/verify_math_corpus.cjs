// Original examples exercise the production preview, not a second TeX renderer.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["webkit", "chromium"].includes(engine));
const sample = JSON.parse(
  execFileSync(
    process.env.PYTHON || "python3",
    [
      "-c",
      String.raw`
import ai_tutor as t,json
from unittest.mock import patch
formulas=[r'x_i^2+x^{n+1}',r'\frac{a+b}{c-d}',r'\sqrt[3]{x}',r'\emptyset\subseteq A\cup B',r'\forall x\in A,\exists y\in B',r'\alpha+\beta=\Gamma',r'\sum_{i=1}^{n}i',r'\int_0^1 x\,dx',r'\lim_{x\to0}\frac{\sin x}{x}',r'\begin{pmatrix}a&b\\c&d\end{pmatrix}',r'\begin{cases}x^2&x\ge0\\0&x<0\end{cases}',r'\begin{aligned}x&=a+b\\y&=c\end{aligned}',r'\overline{A}\cap\underline{B}',r'\mathbf{v}:\mathbb{R}\to\mathcal{X}',r'\left\langle x,y\right\rangle',r'\underbrace{x+\cdots+x}_{n}',r'\binom{n}{k}',r'\text{for every }x\in A',r'\textcircled{\times}+\textcircled{+}',r'\Bigg\downarrow',r'A\times B\tag{9}',r'\begin{array}{ccc}A&\to&B\\\Bigg\downarrow&&\Bigg\downarrow\\C&\to&D\end{array}',r'|x|+\|y\|',r'\text{cost \$10}',r'\overline{ab}',r'x_1+x_2+x_3+x_4+x_5+x_6+x_7+x_8+x_9+x_{10}+x_{11}+x_{12}']
rows=[]
for i,f in enumerate(formulas):
    payload={'position':{'index':1},'quote':'$$\n'+f+'\n$$'};before=json.dumps(payload)
    rows.append('<section id="case-'+str(i)+'"><h3>Original '+str(i+1)+'</h3>'+t.source_preview({'type':'txt','title':'Original','chapters':[{'title':'One'}]},payload)+'</section>')
    assert json.dumps(payload)==before
rows.append('<section id="prose">'+t.answer_html('Amount $10; code '+chr(96)+r'\begin{matrix}'+chr(96)+'. Inline $a+b$ continues in prose.',source=True)+'</section>')
rows.append('<section id="broken">'+t.answer_html(r'Before $\overline{x$ after.',source=True)+'</section>')
print(json.dumps({'html':''.join(rows),'count':len(formulas)}))
`,
    ],
    { encoding: "utf8" },
  ),
);
(async () => {
  const browser = await { chromium, webkit }[engine].launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(base + "/math-corpus-check.html", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/layout.css"><main class="ai-answer" style="margin:24px;width:720px">' +
          sample.html +
          "</main>",
      }),
    );
    await page.goto(base + "/math-corpus-check.html");
    for (const width of [280, 720])
      for (const theme of ["paper", "sage", "blue", "night"]) {
        await page.evaluate(
          ({ width, theme }) => {
            document.body.dataset.theme = theme;
            document.querySelector("main").style.width = width + "px";
          },
          { width, theme },
        );
        const result = await page.evaluate((count) => {
          const cases = Array.from({ length: count }, (_, i) => {
            const host = document.querySelector("#case-" + i),
              math = host.querySelector("math");
            return {
              math: host.querySelectorAll("math").length,
              error: host.querySelectorAll("merror,.math-unavailable").length,
              area:
                math?.getBoundingClientRect().width *
                math?.getBoundingClientRect().height,
              source: [...host.querySelectorAll("annotation")].some(
                (n) => n.getBoundingClientRect().width > 0,
              ),
            };
          });
          return {
            cases,
            prose: document.querySelector("#prose").innerText,
            broken: document.querySelector("#broken").innerText,
            bodyWidth: document.body.scrollWidth,
          };
        }, sample.count);
        result.cases.forEach((c, i) =>
          assert(
            c.math === 1 && !c.error && c.area > 0 && !c.source,
            JSON.stringify({ i, c, engine, width, theme }),
          ),
        );
        assert(
          result.prose.includes("Amount $10;") &&
            result.prose.includes(String.raw`\begin{matrix}`),
        );
        assert(
          result.broken.includes("〔公式暂无法显示，请查看原文〕") &&
            result.broken.includes("after."),
        );
        assert(
          result.bodyWidth <= 1100,
          "A long formula must not widen the application",
        );
      }
    await page.screenshot({
      path: `qa/math-corpus-${engine}.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        formulas: sample.count,
        layouts: 8,
        rawUnchanged: true,
        malformedFallback: true,
        currencyAndCode: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
