const assert=require('node:assert/strict');
const {webkit,chromium}=require('playwright');
(async()=>{
 const [base,engine='webkit']=process.argv.slice(2);
 assert(['webkit','chromium'].includes(engine));
 assert.equal((await (await fetch(base+'/api/formats')).json()).demo,true);
 const b=await {webkit,chromium}[engine].launch();try{
 const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const reset=await p.request.post(base+'/api/state',{
  data:{bookPrefs:Object.fromEntries(['demo-b','demo-a','demo-c'].map(id=>[id,{tocOpen:true,textMode:'pages'}])),
   positions:Object.fromEntries(['demo-b','demo-a','demo-c'].map(id=>[id,{index:1,top:0,updatedAt:Date.now()}]))}
 });
 assert(reset.ok());
 for(const width of [1024,1280,1600]) {
  await p.setViewportSize({width,height:720});
  for(const id of ['demo-b','demo-a','demo-c']) {
   await p.goto(base+'/#/read/'+id);
   await p.waitForFunction(()=>document.querySelector('#reading-viewport')?.getAttribute('aria-busy')==='false');
   assert.equal(await p.locator('#reader-aside').isVisible(),width>=1100);
   if(width>=1100) {
    const aside=await p.locator('#reader-aside').boundingBox(),view=await p.locator('#reading-viewport').boundingBox();
    assert(view.x>=aside.x+aside.width,`${width}/${id} overlapped`);
   }
   if(id==='demo-c') {
    await p.locator('#reader-settings-open').click();
    await p.waitForFunction(()=>document.querySelector('#reading-viewport').getAttribute('aria-busy')==='false');
    const value=await p.locator('#quick-settings [data-output=pdfZoom]').textContent();
    const zoom=await p.locator('#reader-zoom input').inputValue();
    assert(Math.abs(parseInt(value)-parseInt(zoom))<=1,`${value} != ${zoom}`);
   }
   await p.screenshot({path:`qa/reader-review-${width}-${id}.png`});
  }
 }
 await p.setViewportSize({width:1440,height:900});
 await p.goto(base+'/#/read/demo-b');
 const toc=p.locator('#reader-aside');
 const tocButton=p.locator('#toc-toggle');
 await toc.waitFor({state:'visible'});
 assert.equal(await toc.evaluate(el=>el.matches(':modal')),false);
 await p.locator('#reading-viewport').click({position:{x:320,y:240}});
 assert(await toc.isVisible(),'Clicking the wide reading area must leave the docked TOC open.');
 await p.setViewportSize({width:760,height:850});
 await toc.waitFor({state:'hidden'});
 await tocButton.click();
 assert.equal(await toc.evaluate(el=>el.matches(':modal')),true);
 const chapter=toc.locator('[data-index]').first();
 await chapter.focus();
 const currentPage=await p.locator('#page-label').textContent();
 await p.keyboard.press('ArrowRight');
 assert.equal(await p.locator('#page-label').textContent(),currentPage);
 await p.keyboard.press('Escape');
 await toc.waitFor({state:'hidden'});
 assert.equal(await tocButton.evaluate(el=>document.activeElement===el),true);
 await tocButton.click();
 await toc.locator('[data-index="2"]').first().click();
 await toc.waitFor({state:'hidden'});
 await p.waitForFunction(()=>document.querySelector('#page-label').dataset.chapter==='2');
 assert.equal(await p.locator('#reading-viewport').evaluate(el=>document.activeElement===el),true);
 await p.locator('#reader-back').click();
 await p.waitForFunction(()=>document.querySelector('#page-label').dataset.chapter==='1');
 await p.setViewportSize({width:1440,height:900});
 await toc.waitFor({state:'visible'});
 await p.waitForFunction(()=>document.querySelector('#reading-viewport').getAttribute('aria-busy')==='false');
 await toc.locator('#toc-close').click();
 await toc.waitFor({state:'hidden'});
 await p.setViewportSize({width:760,height:850});
 await tocButton.click();
 await p.mouse.click(600,400);
 await toc.waitFor({state:'hidden'});
 assert.equal(await tocButton.evaluate(el=>document.activeElement===el),true);
 await p.setViewportSize({width:1440,height:900});
 await p.waitForTimeout(150);
 assert.equal(await toc.isVisible(),false,'Temporary opening must not reset the closed desktop preference.');
 await tocButton.click();
 await toc.waitFor({state:'visible'});
 await p.setViewportSize({width:1280,height:720});await p.goto(base+'/#/library');
 await p.waitForSelector('.library-book h3');
 const title=await p.locator('.library-book:not([hidden]) h3').first().boundingBox();assert(title.y+title.height<=720,JSON.stringify(title));
 await p.screenshot({path:'qa/reader-review-library.png'});
 await p.setViewportSize({width:600,height:850});await p.goto(base+'/#/read/demo-b');
 await p.waitForFunction(()=>document.querySelector('#reading-viewport').getAttribute('aria-busy')==='false');
 await p.locator('#reading-viewport').click({position:{x:280,y:200}});
 await p.waitForFunction(()=>document.querySelector('#reader').classList.contains('focused'));
 const exitFocus=await p.locator('#focus-exit').boundingBox();
 const focusViewport=await p.locator('#reading-viewport').boundingBox();
 assert(exitFocus.y+exitFocus.height<=focusViewport.y,'The focus exit must sit above the scrollable text.');
 await p.locator('#reading-viewport').click({position:{x:280,y:200}});
 await p.waitForFunction(()=>!document.querySelector('#reader').classList.contains('focused'));
 await p.screenshot({path:'qa/reader-review-narrow.png'});
 const before = await p.locator('#page-label').textContent();
 const swipe = () => p.evaluate(()=>{
  const target=document.querySelector('#reading-viewport');
  for(const [name,field,x] of [['touchstart','touches',450],['touchend','changedTouches',100]]) {
   const event=new Event(name,{bubbles:true});Object.defineProperty(event,field,{value:[{clientX:x,clientY:300}]});target.dispatchEvent(event);
  }
 });
 await swipe();await p.waitForFunction(before=>document.querySelector('#page-label').textContent!==before,before);
 const selectedPage=await p.locator('#page-label').textContent();
 await p.evaluate(()=>{const p=document.querySelector('.chapter-body p');const range=document.createRange();range.selectNodeContents(p);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)});
 await swipe();await p.waitForTimeout(500);
 assert.equal(await p.locator('#page-label').textContent(),selectedPage,'Selection must prevent swiping pages');

 await p.locator('#ask-selection').click();
 const question=p.locator('#question-input');
 await question.waitFor({state:'visible'});
 if (await p.evaluate(()=>CSS.supports('field-sizing','content'))) {
  const height=()=>question.evaluate(el=>el.clientHeight);
  const empty=await height();
  await question.fill('一行测试\n'.repeat(7));
  assert(await height()>empty);
  await question.fill('一行测试\n'.repeat(50));
  assert(await question.evaluate(el=>el.scrollHeight>el.clientHeight && el.clientHeight<=220));
  await question.fill('');
  assert.equal(await height(),empty);
 }
 await p.locator('#question-close').click();

 await p.emulateMedia({reducedMotion:'reduce'});
 assert((await p.request.post(base+'/api/state',{
  data:{bookPrefs:{'demo-b':{textMode:'scroll'}},positions:{'demo-b':{index:1,top:0,updatedAt:Date.now()}}}
 })).ok());
 await p.setViewportSize({width:760,height:560});
 await p.reload();
 const viewport=p.locator('#reading-viewport');
 await p.waitForFunction(()=>{
  const view=document.querySelector('#reading-viewport');
  return view.getAttribute('aria-busy')==='false' && view.scrollHeight>view.clientHeight;
 });
 await viewport.evaluate(view=>{
  const scrollBy=view.scrollBy;
  view.scrollBy=function(options){this.dataset.testScrollBehavior=options.behavior;return scrollBy.call(this,options)};
 });
 await p.waitForTimeout(250);
 await p.locator('#next-button').click();
 assert.equal(await viewport.getAttribute('data-test-scroll-behavior'),'auto');
 const top=await viewport.evaluate(el=>el.scrollTop);
 assert(top>0);
 await p.waitForFunction(async top=>{
  const state=await (await fetch('/api/state')).json();
  return Math.abs((state.positions['demo-b']?.top || 0)-top)<2;
 },top);

 await p.setViewportSize({width:320,height:480});
 const tools=p.locator('#reader-more summary');
 await p.waitForFunction(()=>document.querySelector('#reader-pinned-tools').childElementCount===0);
 const toolBox=await tools.boundingBox(), bar=await p.locator('#reader-bar').boundingBox();
 assert(toolBox && toolBox.x>=bar.x && toolBox.x+toolBox.width<=bar.x+bar.width);
 await tools.click(); await p.locator('#book-options').waitFor();
 const chapterBefore=await p.locator('#page-label').textContent();
 await p.locator('#book-options').press('ArrowRight');
 assert.equal(await p.locator('#page-label').textContent(),chapterBefore);
 await p.keyboard.press('Escape');
 assert(await tools.evaluate(el=>document.activeElement===el && !el.parentElement.open));
 await tools.press('Enter'); await p.locator('#book-options').click();
 await p.locator('#book-dialog[open]').waitFor(); await p.keyboard.press('Escape');
 assert(await tools.evaluate(el=>document.activeElement===el && !el.parentElement.open));

 assert.deepEqual(errors,[]);console.log(`${engine}: layout, responsive TOC, zoom, reduced motion and scroll persistence passed`);
 }finally{await b.close()}
})().catch(e=>{console.error(e);process.exit(1)});
