// Installed by the native reader in each publication frame; books do not supply this code.
window.pageBetweenSelectedSource = () => {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const maths = [...document.querySelectorAll('math,.katex')].filter(node => !(node.localName === 'math' && node.closest('.katex')) && range.intersectsNode(node));
  if (!maths.length) return selection.toString();
  for (const math of maths) {
    if (math.contains(range.startContainer)) range.setStartBefore(math);
    if (math.contains(range.endContainer)) range.setEndAfter(math);
  }
  const fragment = range.cloneContents();
  const copies = [...fragment.querySelectorAll('math,.katex')].filter(node => !(node.localName === 'math' && node.closest('.katex')));
  for (const [index, math] of copies.entries()) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent || math.getAttribute('alttext');
    if (!tex) continue;
    const display = maths[index].getAttribute('display') === 'block' || maths[index].closest('.katex-display,.math.display');
    const delimiter = display ? '$$' : '$';
    math.replaceWith(document.createTextNode(delimiter + tex + delimiter));
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
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
};
