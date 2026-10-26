// Original short and mixed-size pages exercise more than three visible PDF pages.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium, webkit } = require("playwright");
const base = process.argv[2],
  engine = process.argv[3] || "webkit";
assert(base && ["chromium", "webkit"].includes(engine));
async function api(path, body) {
  const r = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const d = await r.json();
  assert(r.ok, d.error);
  return d;
}
function fixture(mixed) {
  return execFileSync(process.env.PYTHON || "python3", [
    "-c",
    `
import io,sys
from reportlab.pdfgen import canvas
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(600,90),invariant=1)
c.setTitle('Original viewport sample')
for n in range(30):
 c.setPageSize((600,${mixed === "extreme" ? "[70,1000,160,600][n%4]" : `360 if ${mixed ? "True" : "False"} and n%2 else 90`}))
 c.setFillColorRGB(.1,.3,.2);c.rect(20,10,560,70,fill=1)
 c.setFillColorRGB(1,1,1);c.drawString(40,40,'Original page '+str(n+1));c.showPage()
c.save();sys.stdout.buffer.write(b.getvalue())
`,
  ]);
}
(async () => {
  const state = await api("/api/state"),
    browser = await { chromium, webkit }[engine].launch();
  let cases = 0;
  try {
    for (const mixed of [false, true, "extreme"]) {
      const r = await fetch(
        base +
          `/api/import?name=original-${mixed || "short"}-viewport.pdf&parse=0`,
        { method: "POST", body: fixture(mixed) },
      );
      const { book } = await r.json();
      assert(r.ok);
      await api("/api/state", {
        prefs: { pdfMode: "scroll", pdfZoom: 75 },
        positions: { [book.id]: { index: 1, top: 0, updatedAt: Date.now() } },
      });
      const p = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(base + "/#/read/" + book.id);
      await p.waitForFunction(
        () =>
          !document.querySelector("#ai-open").disabled &&
          document
            .querySelector("#reading-viewport")
            .getAttribute("aria-busy") === "false",
      );
      async function allVisible() {
        await p.waitForFunction(() => {
          const view = document
            .querySelector("#reading-viewport")
            .getBoundingClientRect();
          return [...document.querySelectorAll(".pdf-page")]
            .filter((r) => {
              const b = r.getBoundingClientRect();
              return b.top < view.bottom && b.bottom > view.top;
            })
            .every(
              (r) =>
                r.dataset.rendered === "ready" &&
                r.querySelector("canvas")?.width,
            );
        });
      }
      await allVisible();
      const count = await p.evaluate(() => {
        const v = document
          .querySelector("#reading-viewport")
          .getBoundingClientRect();
        return [...document.querySelectorAll(".pdf-page")].filter((r) => {
          const b = r.getBoundingClientRect();
          return b.top < v.bottom && b.bottom > v.top;
        }).length;
      });
      if (!mixed)
        assert(
          count > 3,
          "The fixture must expose the old three-page assumption.",
        );
      for (const target of [10, 3, 21, 30, 1, 9, 18, 2, 22, 7, 15, 5, 24]) {
        await p.locator("#page-label").click();
        await p.locator("#page-jump-input").fill(String(target));
        await p.locator("#page-dialog button[type=submit]").click();
        await allVisible();
        await p.waitForTimeout(500);
        assert.equal(
          await p.locator("#page-label").getAttribute("data-chapter"),
          String(target),
          "Short or mixed pages must not skip the requested target.",
        );
        cases++;
      }
      await p.setViewportSize({ width: 1280, height: 1100 });
      await p.waitForTimeout(150);
      await allVisible();
      cases++;
      assert.deepEqual(errors, []);
      await p.close();
    }
    console.log(
      JSON.stringify({
        engine,
        cases,
        allVisiblePagesDrawn: true,
        shortPageJump: true,
        mixedSizeJump: true,
        resize: true,
      }),
    );
  } finally {
    await browser.close();
    await api("/api/state", {
      prefs: {
        pdfMode: state.prefs.pdfMode || "scroll",
        pdfZoom: state.prefs.pdfZoom || 100,
      },
    });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
