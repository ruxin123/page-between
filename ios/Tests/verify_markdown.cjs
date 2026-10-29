const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { webkit } = require('playwright');
(async()=>{
 const browser=await webkit.launch();
 try {
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
  await page.goto(pathToFileURL(path.resolve(__dirname,'../PageBetween/Web/markdown.html')).href);
  const samples=[String.raw`A set $S_n$ contains $\sigma$.`,String.raw`$$f(x)=\begin{cases}x^2 & x>0\\0 & x\le0\end{cases}$$`,String.raw`$$\begin{pmatrix}1&2&3\\3&1&2\end{pmatrix}$$`,String.raw`The empty set is $\varnothing$; spacing $f\text{ and }g$.`];
  for(const text of samples){
   const result=await page.evaluate(async text=>{
    const height=await window.renderMarkdown(text);
    return {height,formulas:document.querySelectorAll('.katex').length,errors:document.querySelectorAll('.katex-error').length,annotations:[...document.querySelectorAll('annotation')].map(n=>n.textContent)};
   },text);
   assert(result.height>0&&result.formulas>0&&!result.errors,JSON.stringify(result));
  }
  const safety=await page.evaluate(async()=>{
   await window.renderMarkdown('<script>window.compromised=true</script>\n\n![remote](https://example.org/tracking.png)\n\n[bad](javascript:alert(1))');
   return {scripts:document.querySelectorAll('#content script').length,images:document.querySelectorAll('#content img').length,bad:document.querySelectorAll('#content [href^="javascript:"]').length,compromised:!!window.compromised};
  });
  assert.deepEqual(safety,{scripts:0,images:0,bad:0,compromised:false});
  const copied=await page.evaluate(async()=>{
   await window.renderMarkdown(String.raw`Since $\sigma\in S_n$, continue.`);
   const formula=document.querySelector('.katex-html .mord'),range=document.createRange();
   range.selectNodeContents(formula);getSelection().removeAllRanges();getSelection().addRange(range);
   const data=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));
   return data.getData('text/plain');
  });
  assert.equal(copied,String.raw`$\sigma\in S_n$`);
  await page.addScriptTag({url:pathToFileURL(path.resolve(__dirname,'../PageBetween/Web/selection.js')).href});
  const source=await page.evaluate(async()=>{
   await window.renderMarkdown(String.raw`$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$`);
   const range=document.createRange();range.selectNodeContents(document.querySelector('.katex-html .mord'));getSelection().removeAllRanges();getSelection().addRange(range);
   return window.pageBetweenSelectedSource();
  });
  assert.equal(source,String.raw`$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$`);
  assert.equal(await page.evaluate(async()=>{await window.renderMarkdown('Prices range from $50 to $70.');return document.querySelectorAll('.katex').length}),0);
  const sizes=await page.evaluate(async()=>{const long=await window.renderMarkdown('Long paragraph. '.repeat(300));const short=await window.renderMarkdown('Short.');return {long,short}});
  assert(sizes.short<sizes.long/4,JSON.stringify(sizes));
  console.log(JSON.stringify({engine:'webkit',viewport:'iPhone 390x844',mathFamilies:samples.length,safeMarkup:true,partialFormulaCopyPreservesTeX:true,heightCanShrink:true}));
 } finally { await browser.close() }
})().catch(error=>{console.error(error);process.exitCode=1});
