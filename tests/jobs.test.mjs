import assert from "node:assert/strict";
import { taskEntries } from "../ui/jobs.mjs";
import { formatPages } from "../ui/mineru.mjs";

assert.equal(formatPages([1, 2, 3, 7, 9, 10]), "1-3,7,9-10");
assert.equal(formatPages([6]), "6");
assert.equal(formatPages([]), "");

const books = [
  {
    id: "a",
    title: "示例 A",
    type: "pdf",
    parseEnabled: true,
    processing: "ready",
    processingNote: "重试成功",
  },
  {
    id: "b",
    title: "示例 B",
    type: "epub",
    parseEnabled: false,
    processing: "ready",
  },
];
const jobs = [
  { book: "a", status: "ready", phase: "完成", startedAt: 2 },
  { book: "a", status: "error", phase: "旧错误", startedAt: 1 },
];
let entries = taskEntries(books, jobs);
assert.equal(entries.length, 2, "Books without a queued task still appear.");
assert.equal(entries[0].status, "ready");
assert.equal(entries[0].phase, "完成");
assert.equal(
  taskEntries(books, jobs.slice(1))[0].status,
  "ready",
  "Legacy failures do not override current book state.",
);
books[0].processing = "pending";
assert.equal(taskEntries(books, jobs)[0].status, "running");
books[0].processing = "error";
assert.equal(taskEntries(books, jobs)[0].status, "error");
books[0].parseEnabled = false;
assert.equal(
  taskEntries(books, jobs)[0].status,
  "ready",
  "Disabling enhancement clears its active alert.",
);
books[0].parseEnabled = true;
books[0].processing = "ready";
const paused = taskEntries(books, [
  {
    book: "a",
    kind: "mineru",
    status: "paused",
    phase: "保留进度",
    pages: [2, 3],
  },
])[0];
assert.equal(paused.status, "paused");
assert.equal(paused.kind, "mineru");
assert.deepEqual(paused.pages, [2, 3]);
books[0].localPreparation = {
  status: "running",
  completed: 4,
  total: 12,
  activePage: 9,
  failedPages: [],
};
const simultaneous = taskEntries(books, [
  {
    book: "a",
    kind: "mineru",
    status: "paused",
    phase: "云端已暂停",
    pages: [1, 2],
  },
]);
assert.equal(simultaneous.length, 3);
assert.equal(simultaneous[0].kind, "mineru");
assert.equal(simultaneous[0].status, "paused");
assert.equal(simultaneous[2].kind, "selection");
assert.equal(simultaneous[2].status, "running");
assert.match(simultaneous[2].phase, /4 \/ 12/);
console.log("任务按书聚合、历史失败恢复与关闭增强状态：通过。");
