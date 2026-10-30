window.renderMarkdown = async (text, images = []) => {
  const formulas = [];
  const prose = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\d)/g, (raw, display, bracket, parenthesis, inline) => {
    const index = formulas.push({ tex: display ?? bracket ?? parenthesis ?? inline, display: display !== undefined || bracket !== undefined }) - 1;
    return `<span data-formula="${index}"></span>`;
  });
  const root = document.getElementById('content');
  root.innerHTML = DOMPurify.sanitize(marked.parse(prose), {USE_PROFILES:{html:true}, FORBID_TAGS:['img','style','iframe','form']});
  for (const node of root.querySelectorAll('[data-formula]')) {
    const item = formulas[Number(node.dataset.formula)];
    if (item) {
      node.dataset.display = String(item.display);
      try { katex.render(item.tex, node, {displayMode:item.display,throwOnError:true,trust:false,strict:'ignore'}); }
      catch {
        const source = images.find(image => image.raw.trim() === item.tex.trim() && /^data:image\/png;base64,/.test(image.src));
        if (source) {
          const image = document.createElement('img');
          image.src = source.src; image.alt = '原书公式'; image.dataset.originalTex = item.tex;
          node.replaceChildren(image);
        } else { node.textContent = '公式无法显示'; node.dataset.originalTex = item.tex; }
      }
    }
  }
  await Promise.all([...root.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
  await document.fonts.ready;
  return Math.ceil(root.getBoundingClientRect().height);
};

document.addEventListener('copy', event => {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
  const range = selection.getRangeAt(0).cloneRange();
  const nodes = [...document.querySelectorAll('.katex,[data-original-tex]')].filter(node => range.intersectsNode(node));
  if (!nodes.length) return;
  for (const node of nodes) {
    if (node.contains(range.startContainer)) range.setStartBefore(node);
    if (node.contains(range.endContainer)) range.setEndAfter(node);
  }
  const fragment = range.cloneContents();
  for (const [index, node] of [...fragment.querySelectorAll('.katex,[data-original-tex]')].entries()) {
    const tex = node.dataset.originalTex ?? node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!tex) return;
    const delimiter = nodes[index]?.closest('.katex-display') || nodes[index]?.closest('[data-formula]')?.dataset.display === 'true' ? '$$' : '$';
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
