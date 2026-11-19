// Requires an isolated authored demo library; changes sample reading positions.
const { webkit } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const base = process.argv[2];
  assert(base);
  assert.equal((await (await fetch(base + '/api/formats')).json()).demo, true, 'Use an isolated authored demo library');
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [], referenceWrites = [], referenceChapters = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes('/content/') && request.frame().url().includes('mode=reference'))
        referenceChapters.push(request.url());
      if (request.url().endsWith('/api/state') && request.method() === 'POST' && request.frame().url().includes('mode=reference')) referenceWrites.push(request.postData());
    });
    const ready = frame => frame.waitForFunction(() => document.querySelector('#reading-viewport').getAttribute('aria-busy') === 'false');
    const chapter = frame => frame.locator('#page-label').getAttribute('data-chapter');
    const state = async () => (await page.request.get(base + '/api/state')).json();
    for (const [book, main] of [['demo-c', 3], ['demo-b', 2], ['demo-a', 2]]) {
      await page.goto('about:blank');
      await page.request.post(base + '/api/state', { data: { positions: { [book]: { index: main, pdfY: 0, top: 0, updatedAt: Date.now() } } } });
      await page.goto(base + '/#/read/' + book);
      await ready(page);
      assert.equal(await chapter(page), String(main));
      if (!await page.locator('#comparison-open').isVisible()) await page.locator('#reader-more summary').click();
      const requestStart = referenceChapters.length;
      await page.locator('#comparison-open').click();
      await page.locator('.comparison-loading').waitFor({ state: 'hidden', timeout: 45000 });
      if (book === 'demo-a') assert.equal(referenceChapters.length - requestStart, 1, 'Cold EPUB comparison fetches exactly one chapter');
      await page.locator('.comparison-handle').press('ArrowLeft');
      await ready(page);
      assert.equal(await chapter(page), String(main), 'Resizing must not also turn the main page');
      const reference = page.frames().find(frame => frame.url().includes('mode=reference'));
      assert(reference);
      await ready(reference);
      assert.equal(await chapter(reference), String(main));
      await reference.locator('#reading-viewport').press('Meta+[');
      await ready(reference);
      await page.waitForTimeout(700);
      assert.equal(await chapter(reference), String(main - 1));
      assert.equal(await chapter(page), String(main));
      const saved = await state();
      assert.equal(saved.positions[book].index, main);
      const input = reference.locator('#reader-zoom input');
      await input.fill('150%');
      await input.press('Enter');
      await ready(reference);
      const after = await state();
      assert.deepEqual(after.bookPrefs?.[book] || {}, saved.bookPrefs?.[book] || {});
      assert.equal(await input.inputValue(), '150%');
      await page.screenshot({ path: `qa/comparison-${book}.png` });
      await page.locator('.comparison-pane [data-close]').click();
      await ready(page);
      // Include the teardown beacon and subsequent progress polling in the check.
      await page.waitForTimeout(1000);
      assert.equal(await chapter(page), String(main));
      assert.equal((await state()).positions[book].index, main);
      assert.equal(page.frames().filter(frame => frame.url().includes('mode=reference')).length, 0);
      console.log(book, 'independent navigation, zoom, resize, saved position and close passed');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(referenceWrites, [], 'Reference teardown must not write reading progress');
    const primary = await chapter(page);
    await page.setViewportSize({ width: 700, height: 900 });
    if (!await page.locator('#comparison-open').isVisible()) await page.locator('#reader-more summary').click();
    await page.locator('#comparison-open').click();
    await page.locator('.comparison-loading').waitFor({ state: 'hidden', timeout: 45000 });
    const rectangle = await page.locator('.comparison-pane').boundingBox();
    assert(rectangle.y === 0 && rectangle.width === 700 && rectangle.height >= 800);
    const reference = page.frames().find(frame => frame.url().includes('mode=reference'));
    const mainTab = page.getByRole('tab', { name: '正文' });
    const referenceTab = page.getByRole('tab', { name: '对照' });
    assert.equal(await referenceTab.getAttribute('aria-selected'), 'true');
    const primaryPage = await page.locator('#page-label').textContent();
    const referencePage = await reference.locator('#page-label').textContent();
    await referenceTab.press('PageDown');
    await referenceTab.press('Meta+[');
    assert.equal(await page.locator('#page-label').textContent(), primaryPage);
    assert.equal(await reference.locator('#page-label').textContent(), referencePage);
    await referenceTab.press('ArrowLeft');
    assert.equal(await mainTab.getAttribute('aria-selected'), 'true');
    assert(await mainTab.evaluate(element => document.activeElement === element));
    assert(await page.locator('#reader').isVisible());
    assert(!await page.locator('.comparison-pane').isVisible());
    await mainTab.press('ArrowRight');
    assert(await page.locator('.comparison-pane').isVisible());
    assert.equal(page.frames().find(frame => frame.url().includes('mode=reference')), reference);
    assert.equal(await chapter(page), primary);
    await page.screenshot({ path: 'qa/comparison-switch.png' });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator('.comparison-switcher').waitFor({ state: 'hidden' });
    await reference.waitForFunction(() => document.activeElement?.id === 'reading-viewport');
    assert.equal(await chapter(page), primary);
    assert.equal(await reference.locator('#page-label').getAttribute('data-chapter'), primary);
    await page.setViewportSize({ width: 700, height: 900 });
    assert.equal(await referenceTab.getAttribute('aria-selected'), 'true');
    await referenceTab.press('Escape');
    await page.locator('.comparison-pane').waitFor({ state: 'hidden' });
    assert.equal(await chapter(page), primary);
    console.log('Full-height narrow-window switching and main location passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
