import assert from "node:assert/strict";
import {
  filterBooks,
  reconcileCards,
  cover,
  nextVisibleCard,
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
