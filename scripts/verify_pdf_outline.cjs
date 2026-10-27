// Use an isolated library. Default fixtures are original; private books stay local.
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
function flatten(items) {
  return items.flatMap((item) => [item, ...flatten(item.children || [])]);
}
(async () => {
  const original = await api("/api/state");
  let book;
  if (process.env.OUTLINE_BOOK) {
    book = (await api("/api/library")).books.find(
      (b) => b.id === process.env.OUTLINE_BOOK,
    );
  } else {
    const bytes = execFileSync(process.env.PYTHON || "python3", [
      "-c",
      `
import io,sys
from reportlab.pdfgen import canvas
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(600,1000),invariant=1)
c.setTitle('Original in-page outline')
for page in range(3):
 for section,y in enumerate((860,520,32)):
  name='section-'+str(page)+'-'+str(section)
  c.bookmarkPage(name,fit='XYZ',left=60,top=y)
  c.addOutlineEntry('Original section '+str(page+1)+'.'+str(section+1),name)
  c.setFont('Helvetica',14);c.drawString(60,y-16,'Original section '+str(page+1)+'.'+str(section+1))
 c.showPage()
c.save();sys.stdout.buffer.write(b.getvalue())
`,
    ]);
    const r = await fetch(
      base + "/api/import?name=original-outline.pdf&parse=0",
      { method: "POST", body: bytes },
    );
    const data = await r.json();
    assert(r.ok);
    book = data.book;
  }
  assert(book?.type === "pdf");
  assert.equal(book.pdfOutlineVersion, 1);
  const entries = flatten(book.toc),
    browser = await { chromium, webkit }[engine].launch();
  let cases = 0;
  try {
    for (const mode of ["scroll", "pages"]) {
      await api("/api/state", {
        prefs: { pdfMode: mode, pdfZoom: 100 },
        positions: {
          [book.id]: { index: 1, top: 0, pdfY: 0, updatedAt: Date.now() },
        },
      });
      const p = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
        }),
        errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(base + "/#/read/" + book.id);
      const ready = () =>
        p.waitForFunction(
          () =>
            document
              .querySelector("#reading-viewport")
              .getAttribute("aria-busy") === "false" &&
            !document.querySelector("#ai-open").disabled,
        );
      await ready();
      const at = (item) =>
        p.waitForFunction(
          ({ index, y }) => {
            const root = document.querySelector(
                '.pdf-page[data-page="' + index + '"]',
              ),
              view = document.querySelector("#reading-viewport");
            if (!root || root.dataset.rendered !== "ready") return false;
            const actual =
              (view.getBoundingClientRect().top -
                root.getBoundingClientRect().top) /
              root.offsetHeight;
            return (
              document.querySelector("#page-label").dataset.chapter ===
                String(index) && Math.abs(actual - y) < 0.004
            );
          },
          { index: item.index, y: item.pdfY },
        );
      // All destinations, including repeated page numbers and headings near the footer.
      for (const [i, item] of entries.entries()) {
        const button = p.locator('#toc-list [data-toc-entry="' + i + '"]');
        await button.evaluate((el) => {
          for (let n = el.parentElement; n; n = n.parentElement)
            if (n.tagName === "DETAILS") n.open = true;
        });
        await button.click();
        await ready();
        await at(item);
        await p.waitForTimeout(260);
        assert.equal(
          await p
            .locator('#toc-list [aria-current="true"]')
            .getAttribute("data-toc-entry"),
          String(i),
        );
        const saved = (await api("/api/state")).positions[book.id];
        assert.equal(saved.index, item.index);
        assert(Math.abs(saved.pdfY - item.pdfY) < 0.004);
        cases++;
      }
      const last = entries.at(-1);
      await p.locator("#reader-back").click();
      await ready();
      await at(entries.at(-2));
      await p
        .locator('#toc-list [data-toc-entry="' + (entries.length - 1) + '"]')
        .click();
      await ready();
      await at(last);
      await p.reload();
      await ready();
      await at(last);
      assert.deepEqual(errors, []);
      await p.close();
    }
    console.log(
      JSON.stringify({
        engine,
        cases,
        inPageDestinations: true,
        samePageActiveSection: true,
        footerKeepsPage: true,
        savedAndReopened: true,
        returnToPreviousSection: true,
        privateBook: !!process.env.OUTLINE_BOOK,
      }),
    );
  } finally {
    await browser.close();
    await api("/api/state", {
      prefs: {
        pdfMode: original.prefs.pdfMode || "scroll",
        pdfZoom: original.prefs.pdfZoom || 100,
      },
    });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
