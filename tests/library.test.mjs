import assert from "node:assert/strict";
import {
  filterBooks,
  reconcileCards,
  cover,
  nextVisibleCard,
  resumableBook,
} from "../ui/library.mjs";

const books = [
  {
    id: "a",
    title: "示例甲",
    author: "演示作者",
    format: "EPUB",
    shelf: "小说",
    onShelf: true,
  },
  {
    id: "b",
    title: "Example B",
    author: "Demo",
    format: "PDF",
    shelf: "学习",
    onShelf: false,
  },
];
assert.deepEqual(
  filterBooks(books, "pinned").map((b) => b.id),
  ["a"],
);
assert.deepEqual(
  filterBooks(books, "学习", " demo ").map((b) => b.id),
  ["b"],
);
assert.equal(filterBooks(books, "小说", "PDF").length, 0);
assert.equal(filterBooks(books, "all", "unknown").length, 0);
assert.equal(filterBooks([], "all").length, 0);
assert.equal(resumableBook(books, {}, "a"), undefined);
assert.equal(resumableBook(books, { a: { index: 0 } }, "a"), undefined);
const places = { a: { index: 1, progress: 0, updatedAt: 1 }, b: { index: 2, updatedAt: 2 } };
assert.equal(resumableBook(books, places, "a").id, "a");
assert.equal(resumableBook(books, places).id, "b");
assert.equal(resumableBook(filterBooks(books, "学习"), places, "a").id, "b");
assert.equal(resumableBook(filterBooks(books, "小说"), { b: places.b }, "b"), undefined);
assert.ok(
  cover({ ...books[0], title: '<img src=x onerror="bad">' }).includes(
    "&lt;img",
  ),
);
const cards = new Map(),
  nodes = [];
const grid = {
  append(node) {
    nodes.push(node);
  },
};
const create = (book) => ({
  id: book.id,
  remove() {
    nodes.splice(nodes.indexOf(this), 1);
  },
});
const update = (node, book) => {
  node.pinned = book.onShelf;
};
reconcileCards(grid, books, new Set(["a", "b"]), cards, create, update);
const original = cards.get("a");
reconcileCards(grid, books, new Set(["b"]), cards, create, update);
assert.equal(
  cards.get("a"),
  original,
  "Filtering retains the original card, image and focusable controls.",
);
assert.equal(original.hidden, true);
books[0].onShelf = false;
reconcileCards(grid, books, new Set(["a", "b"]), cards, create, update);
assert.equal(cards.get("a"), original, "A star change updates the same card.");
assert.equal(original.pinned, false);
assert.equal(original.hidden, false);
assert.equal(
  nodes.length,
  2,
  "Repeated renders do not append duplicate cards.",
);
reconcileCards(grid, books.slice(1), new Set(["b"]), cards, create, update);
assert.equal(cards.has("a"), false);
assert.equal(nodes.length, 1);
const adjacent = [
  { hidden: false },
  { hidden: true },
  { hidden: false },
  { hidden: false },
];
assert.equal(nextVisibleCard(adjacent, adjacent[1]), adjacent[2]);
adjacent[2].hidden = adjacent[3].hidden = true;
assert.equal(nextVisibleCard(adjacent, adjacent[1]), adjacent[0]);
adjacent[0].hidden = true;
assert.equal(nextVisibleCard(adjacent, adjacent[1]), undefined);
console.log("书库筛选、内容转义、卡片复用与删除：通过。");

const { inFolder } = await import('../ui/folders.mjs');
const folderBooks = [{id:'a'}, {id:'b'}, {id:'c'}];
const folders = [{id:'math', name:'Math', books:['a', 'c']}];
assert.deepEqual(inFolder(folderBooks, folders, 'math').map(b=>b.id), ['a','c']);
assert.deepEqual(inFolder(folderBooks, folders, 'unfiled').map(b=>b.id), ['b']);
assert.equal(inFolder(folderBooks, folders, ''), folderBooks);
const { metadataHTML } = await import('../ui/book-source.mjs');
const metadata = metadataHTML({isbn:['123','456'], series:{name:'Series'}, categories:['Math','<script>'], rating:0, description:'<img onerror=alert(1)>', description_truncated:true});
assert.match(metadata, /ISBN/); assert.match(metadata, /Series/); assert.match(metadata, /评分/);
assert.match(metadata, /简介节选/); assert.ok(!metadata.includes('<script>')); assert.ok(!metadata.includes('<img'));
assert.ok(!metadataHTML({}).includes('<dt>'));
