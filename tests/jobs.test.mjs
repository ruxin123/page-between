import assert from "node:assert/strict";
import { taskEntries } from "../ui/jobs.mjs";

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
console.log("任务按书聚合、历史失败恢复与关闭增强状态：通过。");
