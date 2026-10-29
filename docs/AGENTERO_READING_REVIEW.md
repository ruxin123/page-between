# 从 Agentero 借鉴阅读性能改进

研究日期：2026-10-29。源码基线：`poco-ai/Agentero@1034143fa13c17a7313fa7b99ce7cea434f0433b`；拉取最近 30 条 Release，重点核对 0.11.6–0.14.0 的阅读更新；最新正式版为 [v0.14.0](https://github.com/poco-ai/Agentero/releases/tag/v0.14.0)。

## 产品边界

页间以书籍阅读为主，覆盖小说、教材和多种电子书格式；Agentero 以论文阅读、整理及科研写作为主。本轮只改善已有 PDF 阅读链路。笔记工作台、论文订阅、Zotero、LaTeX 编译、插件与 Agent 协议等新功能暂不引入，须先讨论实际需要。

## 有用的版本演进

| 发布 | 值得参考的变化 | 对页间的判断 |
| --- | --- | --- |
| [0.11.6](https://github.com/poco-ai/Agentero/releases/tag/v0.11.6) / [0.11.9](https://github.com/poco-ai/Agentero/releases/tag/v0.11.9) | 指针意图才装配选区；页面可见约 180ms 后读取文字；保留旧位图直到替换完成 | 采纳调度原则，减少快速翻页时无用的文字层工作 |
| [0.12.0](https://github.com/poco-ai/Agentero/releases/tag/v0.12.0) | 缩放与分隔条拖动期间合并布局更新，侧栏折叠一次提交布局 | 页间已有窗口 resize 合并与侧栏最终重排；此次不重复增加一套手势系统 |
| [0.12.1](https://github.com/poco-ai/Agentero/releases/tag/v0.12.1) | 固定低清底图、视口高清瓦片、BMP 出图，清除重复瓦片缓存 | 借鉴轻量底图；BMP 与 PDFium / EmbedPDF 渲染输出相关，不能直接套到 PDF.js 的 Canvas |
| [0.13.0](https://github.com/poco-ai/Agentero/releases/tag/v0.13.0) | 真实视口铺瓦片、工具栏按实际宽度定位、去除整页模糊阴影 | 采纳真实可见页优先和轻量纸面边框；不把上游 Linux 帧率当成本机收益 |
| [0.14.0](https://github.com/poco-ai/Agentero/releases/tag/v0.14.0) | 稳定滚动条槽防止 fit-width 二次跳变；翻译逐页增量与独立引擎 | 采纳 PDF 滚动条槽；页间没有全文翻译视图，不引入对应复杂架构 |

源码依据：[PDF 阅读设计](https://github.com/poco-ai/Agentero/blob/1034143fa13c17a7313fa7b99ce7cea434f0433b/docs/frontend/pdf.md)、[页面底图缓存](https://github.com/poco-ai/Agentero/blob/1034143fa13c17a7313fa7b99ce7cea434f0433b/src/components/viewer/pdf/layers/page-bitmap-cache.ts)、[页图和选区装配](https://github.com/poco-ai/Agentero/blob/1034143fa13c17a7313fa7b99ce7cea434f0433b/src/components/viewer/pdf/layers/page-layers.tsx)、[整页阴影复盘](https://github.com/poco-ai/Agentero/blob/1034143fa13c17a7313fa7b99ce7cea434f0433b/docs/bug_fix/pdf-webkit-page-shadow.md)。借鉴实现原则，没有复制其代码或引入新依赖。

## 页间本轮实现

- 实际出现在阅读视口内的页面先绘制，邻页图像仍可预取。
- 原生 PDF 文字层延后到页面持续可见约 180ms，指针进入或按下则立即准备。快速途经页不再默认提取文字。持久 OCR、整书文档准备、MinerU 结果和复制原文均保持原有逻辑。
- 当前文档保留最多 12 页轻量预览，每页至多 0.25 MP，总缓存至多 3 MP。直接从完成的 Canvas 缩小，不进行 PNG 编码、不创建磁盘文件。缩放与重绘时先显示这些预览，高清完成后替换并释放临时画布；换文档清理旧预览。
- 预览覆盖实际可见页，不只覆盖进度指针所在页，避免上一页末尾与下一页同屏时留下空白。
- PDF 纸面改为细边框，移除整页模糊阴影；仅 PDF 视口稳定预留滚动条槽。

## 验证与限制

生产函数插桩使用同一份原创 45 页 PDF，在固定窗口与缩放下对照 `09ce0dd`。WebKit 中，首屏文字提取由 2 页降到 1 页；连续快速经过 6 个位置时，由 18 页降到最终可见的 2 页。控制高清绘制暂缓时，旧版出现不透明加载层且无原文像素，新版仍显示两张有原文像素的可见页预览，完成后移除预览。Chromium 也通过新版调度与预览检查。

这些是受控任务量和像素检查，不是原生 macOS 的滚动 FPS 测量。首次打开从未绘制的页面仍可能等待；放大中的轻量底图暂时不如最终高清图清楚。当前仍是整页高清 Canvas，单页 8 MP、近期高清图 24 MP / 8 页预算保持；没有声称已实现视口高清瓦片。

复测入口：`scripts/verify_pdf_performance.cjs`，仅在隔离书库使用。`PDF_BASELINE=1` 可对照本轮修改前的脚本；真实教材只在本机副本检查，公开资料使用原创样例。

## PDF.js 与 PDFium 的取舍

当前保留 [PDF.js](https://mozilla.github.io/pdf.js/)。它与现有 Web 阅读器、原生文字层和扫描件增强层已经接通；这轮确认的调度与重绘问题不要求更换引擎。[PDFium](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_text.h) 提供细致的字符坐标接口，值得后续精度对照，但不会替代扫描 OCR 或修正 MinerU 公式。

如后续仍有瓶颈，先用相同教材测冷开、连续滚动、400% 缩放、字符选择、峰值内存和取消恢复，再决定是否加入可见区域瓦片，或试验 PDFium。不能仅因另一产品更新顺利就迁移整个阅读引擎。
