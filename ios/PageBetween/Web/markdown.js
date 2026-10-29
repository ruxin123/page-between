window.renderMarkdown = async (text) => {
  const formulas = [];
  const prose = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\d)/g, (raw, display, bracket, parenthesis, inline) => {
    const index = formulas.push({ tex: display ?? bracket ?? parenthesis ?? inline, display: display !== undefined || bracket !== undefined }) - 1;
    return `<span data-formula="${index}"></span>`;
  });
  const root = document.getElementById('content');
  root.innerHTML = DOMPurify.sanitize(marked.parse(prose), {USE_PROFILES:{html:true}, FORBID_TAGS:['img','style','iframe','form']});
  for (const node of root.querySelectorAll('[data-formula]')) {
    const item = formulas[Number(node.dataset.formula)];
    if (item) katex.render(item.tex, node, {displayMode:item.display,throwOnError:false,trust:false,strict:'ignore'});
  }
  await document.fonts.ready;
  return Math.ceil(root.getBoundingClientRect().height);
};

document.addEventListener('copy', event => {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
  const range = selection.getRangeAt(0).cloneRange();
  const nodes = [...document.querySelectorAll('.katex')].filter(node => range.intersectsNode(node));
  if (!nodes.length) return;
  for (const node of nodes) {
    if (node.contains(range.startContainer)) range.setStartBefore(node);
    if (node.contains(range.endContainer)) range.setEndAfter(node);
  }
  const fragment = range.cloneContents();
  for (const [index, node] of [...fragment.querySelectorAll('.katex')].entries()) {
    const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!tex) return;
    const delimiter = nodes[index]?.closest('.katex-display') ? '$$' : '$';
    node.replaceWith(document.createTextNode(delimiter + tex + delimiter));
  }
  const parts = [];
  function visit(node) {
    if (node.nodeType === 3) { parts.push(node.textContent); return; }
    if (node.nodeName === 'BR') { parts.push('\n'); return; }
    const block = ['P','DIV','LI','H1','H2','H3','H4','PRE','BLOCKQUOTE','TR'].includes(node.nodeName);
    if (block) parts.push('\n');
    for (const child of node.childNodes) visit(child);
    if (block) parts.push('\n');
  }
  visit(fragment);
  const text = parts.join('').replace(/\n{3,}/g, '\n\n').trim();
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
});
