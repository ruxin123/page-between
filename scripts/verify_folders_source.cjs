// Run only against an isolated demo library. No real account or download is used.
const assert = require('node:assert/strict');
const {webkit} = require('playwright');
const base = process.argv[2];
(async()=> {
 assert.equal((await (await fetch(base+'/api/formats')).json()).demo, true);
 for (const folder of (await (await fetch(base+'/api/library')).json()).folders || []) {
  if (['原创分类','数学阅读'].includes(folder.name)) await fetch(base+'/api/folders', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({operation:'remove',id:folder.id})});
 }
 const b = await webkit.launch();
 try {
  const p = await b.newPage({viewport:{width:1280,height:900}}), errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base); await p.waitForSelector('#workspace:not([hidden])');
  const total = await p.locator('.library-book:not([hidden])').count(); assert(total>0);
  const bookId = await p.locator('.library-book [data-read]').first().getAttribute('data-read');
  const create = p.getByRole('button',{name:'新建文件夹',exact:true});
  const folder = p.locator('.folder-dialog');
  const name = folder.getByRole('textbox',{name:'名称'});
  const clearOfActions = () => folder.evaluate(d => {
   const input = d.querySelector('input'), css = getComputedStyle(input);
   const outline = parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset);
   const bounds = input.getBoundingClientRect();
   return [...d.querySelectorAll('.dialog-footer button')].every(b => b.getBoundingClientRect().top > bounds.bottom + outline);
  });
  await p.setViewportSize({width:390,height:360});
  await create.focus(); await create.press('Enter');
  assert(await name.evaluate(input=>document.activeElement===input));
  assert(await clearOfActions());
  await folder.screenshot({path:'qa/folder-dialog-narrow.png'});
  await folder.getByRole('button',{name:'取消',exact:true}).click();
  assert(await create.evaluate(button=>document.activeElement===button));
  await create.click(); await name.fill('原创分类'); await name.press('Enter');
  await p.waitForFunction(()=>!document.querySelector('.folder-dialog').open);
  assert(await p.getByRole('button',{name:/原创分类/}).evaluate(button=>document.activeElement===button));
  await create.click(); await name.fill('原创分类'); await name.press('Enter');
  await folder.getByRole('alert').getByText('已有同名文件夹。').waitFor();
  await name.focus(); assert(await clearOfActions());
  await p.keyboard.press('Escape'); await folder.waitFor({state:'hidden'});
  await p.setViewportSize({width:1280,height:900});
  await p.getByRole('button',{name:'全部书籍',exact:true}).click();
  await p.locator('.book-more').first().click({force:true});
  const id = await p.locator('#book-folder option').last().getAttribute('value');
  await p.locator('#book-folder').selectOption(id); await p.locator('#book-save').click();
  await p.waitForFunction(()=>!document.querySelector('#book-dialog').open);
  await p.locator(`[data-folder="${id}"]`).click();
  assert.equal(await p.locator('.library-book:not([hidden])').count(),1);
  await p.reload(); await p.waitForSelector('#workspace:not([hidden])');
  await p.locator(`[data-folder="${id}"]`).click(); assert.equal(await p.locator('.library-book:not([hidden])').count(),1);
  await p.goto(base+'/#/read/'+bookId); await p.reload();
  await p.waitForSelector('#reading-viewport[aria-busy="false"]');
  if (!await p.locator('#book-options').isVisible()) await p.locator('#reader-more summary').click();
  await p.locator('#book-options').click();
  assert.equal(await p.locator('#book-folder').inputValue(),id);
  await p.locator('#book-dialog [aria-label="关闭书籍设置"]').click();
  await p.goto(base+'/#/library'); await p.locator(`[data-folder="${id}"]`).click();
  await p.getByRole('button',{name:'重命名文件夹',exact:true}).click(); await p.locator('.folder-dialog input').fill('数学阅读'); await p.locator('.folder-dialog .primary-button').click();
  await p.waitForFunction(()=>!document.querySelector('.folder-dialog').open);
  await p.screenshot({path:'qa/folders-library.png'});
  p.once('dialog',d=>d.accept()); await p.getByRole('button',{name:'删除文件夹',exact:true}).click();
  await p.waitForFunction(()=>!document.querySelector('[data-folder-action="remove"]'));
  assert.equal(await p.locator('.library-book:not([hidden])').count(), total);
  await p.route('**/api/book-source/query', async route => {
   const data = route.request().postDataJSON();
   const row = {ref:'original-ref',title:'原创数学读本',author:'Original Author',year:2026,publisher:'Original Press',pages:240,format:'epub',size_mb:2.4,language:'English'};
   if(data.operation==='search') {
    assert.equal(data.author,'Original Author'); assert.equal(data.language,'english'); assert.equal(data.exact,true);
    await route.fulfill({json:{rows:[row],routing:{}}});
   } else await route.fulfill({json:{...row,isbn:'000-0-00-000000-0',series:'原创系列',edition:'2',translator:'原创译者',categories:['数学','教材'],rating:4.5,description:'这是用于检查排版的原创简介。',description_truncated:true}});
  });
  await p.goto(base+'/#/source'); await p.locator('.source-filters summary').click();
  await p.locator('[name=author]').fill('Original Author'); await p.locator('[name=language]').selectOption('english'); await p.locator('[name=exact]').check();
  await p.getByRole('button',{name:'搜索',exact:true}).click();
  await p.waitForSelector('.source-result');
  assert.equal(await p.locator('[data-detail-page]').isVisible(),false);
  await p.locator('.source-result').click();
  await p.waitForSelector('.source-metadata');
  assert.equal(await p.locator('[data-catalog]').isVisible(),false);
  assert.match(await p.locator('#book-source-view [data-detail]').innerText(), /000-0-00-000000-0/);
  assert.match(await p.locator('[data-results]').textContent(), /240 页/);
  await p.screenshot({path:'qa/source-rich.png'});
  await p.setViewportSize({width:600,height:850}); await p.screenshot({path:'qa/source-rich-narrow.png'});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.evaluate(()=>document.body.dataset.theme='night'); await p.screenshot({path:'qa/source-rich-night.png'});
  await p.route('**/api/book-source/download', async route => {
   assert.equal(route.request().postDataJSON().ref,'original-ref');
   assert.equal(route.request().postDataJSON().parse,false);
   await route.fulfill({json:{id:'original-task',ref:'original-ref',status:'ready',book:{id:bookId}}});
  });
  await p.locator('[data-download]').click();
  await p.getByRole('button',{name:'开始阅读',exact:true}).waitFor();
  const task = p.locator('.source-task');
  await p.setViewportSize({width:320,height:385});
  assert(await task.evaluate(el=>el.scrollWidth<=el.clientWidth && getComputedStyle(el).position==='static'));
  await task.getByRole('link',{name:'开始阅读',exact:true}).waitFor();
  await p.getByRole('link',{name:'返回搜索结果'}).click();
  assert.equal(await p.locator('.source-result').count(),1);
  assert.equal(await p.locator('[name=author]').inputValue(),'Original Author');
  assert.deepEqual(errors,[]); console.log('Folders CRUD, book assignment, reload, safe removal, rich source details, filters, narrow layout: passed');
 } finally {await b.close()}
})().catch(error=>{console.error(error);process.exit(1)});
