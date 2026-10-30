import { escapeHTML } from "./shared.mjs";

export function referenceMatches(text) {
  const pattern =
    /(?<![A-Za-z])(?:Theorem|Lemma|Proposition|Corollary|Definition|Example|Exercise|Equation|定理|引理|命题|推论|定义|例题|习题|公式|方程)\s*[A-Za-z]?\d+(?:[.\-]\d+)*[a-z]?(?!\d|[.\-]\d)/gi;
  return [...text.matchAll(pattern)];
}

export function decorateReferences(root) {
  const doc = root.ownerDocument,
    walker = doc.createTreeWalker(root, 4),
    nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (!node.parentElement.closest("a,button,math,script,style,nav,code,pre"))
      nodes.push(node);
  for (const node of nodes) {
    const matches = referenceMatches(node.textContent);
    if (!matches.length) continue;
    const fragment = doc.createDocumentFragment();
    let start = 0;
    for (const match of matches) {
      fragment.append(
        doc.createTextNode(node.textContent.slice(start, match.index)),
      );
      const link = doc.createElement("a");
      link.className = "reader-reference";
      link.href = "#book-reference";
      link.dataset.bookReference = match[0];
      link.textContent = match[0];
      link.title = "查找并预览本书来源";
      fragment.append(link);
      start = match.index + match[0].length;
    }
    fragment.append(doc.createTextNode(node.textContent.slice(start)));
    node.replaceWith(fragment);
  }
}

export function createBookSearch({ post, toast, getContext, openSource }) {
  const $ = (id) => document.getElementById(id);
  let revision = 0,
    results = [],
    resultBook,
    resultRevision,
    context;
  async function search() {
    if (!context) return;
    const version = ++revision;
    results = [];
    resultBook = null;
    $("knowledge-results").replaceChildren();
    $("knowledge-results").setAttribute("aria-busy", "true");
    $("knowledge-status").textContent = "搜索中…";
    try {
      const data = await post("/api/index/search", {
        book: context.book,
        query: $("knowledge-query").value.trim(),
        position: context.position,
        previousOnly: $("knowledge-previous").checked,
      });
      if (version !== revision) return;
      results = data.results;
      resultBook = context.book;
      resultRevision = version;
      const { covered, total, unit, partial } = data.status;
      $("knowledge-status").textContent =
        partial ? `仅覆盖 ${covered} / ${total} ${unit}` : "";
      $("knowledge-results").innerHTML = results.length
        ? results
            .map(
              (entry, index) =>
                `<article class="knowledge-result"><button data-knowledge-preview="${index}" aria-expanded="false"><strong>${escapeHTML(entry.label || entry.citation)}</strong><span>${escapeHTML(entry.text.slice(0, 140))}</span><small>${escapeHTML(entry.citation)}</small></button><div class="knowledge-preview" hidden><p>${escapeHTML(entry.text)}</p><button class="secondary-button" data-knowledge-jump="${index}">前往原文</button></div></article>`,
            )
            .join("")
        : '<div class="empty-state">未找到相关内容</div>';
    } catch (error) {
      if (version === revision) {
        $("knowledge-status").textContent = error.message;
        $("knowledge-results").replaceChildren();
      }
    } finally {
      if (version === revision)
        $("knowledge-results").removeAttribute("aria-busy");
    }
  }
  function open(query = "") {
    context = getContext();
    if (!context) return;
    $("knowledge-dialog").showModal();
    $("knowledge-query").value = query;
    $("knowledge-query").focus();
    search();
  }
  $("knowledge-form").onsubmit = (event) => {
    event.preventDefault();
    search();
  };
  $("knowledge-previous").onchange = search;
  $("knowledge-close").onclick = () => $("knowledge-dialog").close();
  $("knowledge-dialog").onclose = () => {
    revision++;
  };
  $("knowledge-results").onclick = (event) => {
    const preview = event.target.closest("[data-knowledge-preview]");
    if (preview) {
      const body = preview.nextElementSibling;
      body.hidden = !body.hidden;
      preview.setAttribute("aria-expanded", String(!body.hidden));
    }
    const jump = event.target.closest("[data-knowledge-jump]");
    if (jump) {
      if (resultRevision !== revision || resultBook !== getContext()?.book)
        return;
      const source = results[Number(jump.dataset.knowledgeJump)];
      if (!source) return;
      $("knowledge-dialog").close();
      openSource(resultBook, source.position);
      toast("已前往来源，可用返回按钮回到刚才的位置。");
    }
  };
  return { open };
}
