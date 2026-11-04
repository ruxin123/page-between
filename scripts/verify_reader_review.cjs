const assert=require('node:assert/strict');
const {webkit}=require('playwright');
(async()=>{
 const base=process.argv[2];assert.equal((await (await fetch(base+'/api/formats')).json()).demo,true);
 const b=await webkit.launch();try{
 const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 for(const width of [1024,1280,1600]) {
  await p.setViewportSize({width,height:720});
  for(const id of ['demo-b','demo-a','demo-c']) {
   await p.goto(base+'/#/read/'+id);
   await p.waitForFunction(()=>document.querySelector('#reading-viewport')?.getAttribute('aria-busy')==='false'&&!document.querySelector('#ai-open').disabled);
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
 await p.setViewportSize({width:1280,height:720});await p.goto(base+'/#/library');
 await p.waitForSelector('.library-book h3');
 const title=await p.locator('.library-book:not([hidden]) h3').first().boundingBox();assert(title.y+title.height<=720,JSON.stringify(title));
 await p.screenshot({path:'qa/reader-review-library.png'});
 await p.setViewportSize({width:600,height:850});await p.goto(base+'/#/read/demo-b');
 await p.waitForFunction(()=>document.querySelector('#reading-viewport').getAttribute('aria-busy')==='false');
 await p.locator('#reading-viewport').click({position:{x:280,y:200}});
 await p.waitForFunction(()=>document.querySelector('#reader').classList.contains('focused'));
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

 assert.deepEqual(errors,[]);console.log('TXT/EPUB/PDF layout, responsive TOC, zoom consistency, library first row: passed');
 }finally{await b.close()}
})().catch(e=>{console.error(e);process.exit(1)});
