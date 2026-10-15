# 页间 · Page Between

一个面向 macOS 的个人阅读原型：原生 EPUB、保留版面的 PDF、可分页的文字书，以及随窗口大小调整字号的掌上阅读窗口。

A local-first reading prototype with native EPUB navigation, enhanced PDF selection, paginated text, and a compact macOS reading window.

当前阶段用于**产品交互与代码评审**。主体是 HTML / CSS / JavaScript，加上 Python 本地服务和两个 Swift 原生组件；还不是打包发行的完整 macOS 应用。

![匿名示例书库](docs/screenshots/library.png)

> 仓库中的书目、封面、插图、正文和截图全部使用自编的虚构演示资料。真实书籍、个人阅读记录、OCR 缓存、凭据与旧截图不在版本控制中。

## 快速开始

已验证环境：Python 3.12、Node.js 22，以及 macOS 上的 Swift 工具链。阅读页面需要现代浏览器；PDF.js 和阅读字体已保存在仓库内，不依赖 CDN。

```sh
git clone https://github.com/ruxin123/page-between.git
cd page-between
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py --demo
```

打开 [http://127.0.0.1:8779/](http://127.0.0.1:8779/)。首次运行会生成五本原创示例资料，供阅读、导入、目录、划词和掌上模式评审。演示资料由 [scripts/create_demo.py](scripts/create_demo.py) 生成，不会读取 Apple 图书或其他私人书库。

在 macOS 上，可先通过以下命令准备按需使用的工具：

```sh
brew install node pandoc tesseract
xcode-select --install
```

- **Node.js**：TXT 通用章节解析。
- **Pandoc**：FB2、Markdown、HTML、DOCX、ODT、RTF 转换；只读 EPUB / TXT 时不需要它。
- **Tesseract**：英文扫描文字识别。
- **Swift + macOS SDK**：首次启动编译中文 OCR 和独立掌上窗口；这两项属于 macOS 能力。其他系统仍可评审网页及可直接读取的文档。

本轮功能不需要 MinerU Token 或大模型 API Key。

## 使用自己的书籍

```sh
python server.py
# 或在已配置环境的 Mac 上双击 start.command
```

打开 [http://127.0.0.1:8778/](http://127.0.0.1:8778/)。普通模式从空书库开始，通过“导入书籍”选择文件；不会自动扫描本机书库。

| 模式         | 地址             | 本地数据目录 |
| ------------ | ---------------- | ------------ |
| 个人阅读     | `127.0.0.1:8778` | `data/`      |
| 匿名评审演示 | `127.0.0.1:8779` | `demo-data/` |

两套资料、进度、书签和 OCR 缓存分开保存，两个数据目录均由 Git 忽略。服务只监听本机回环地址；本仓库上传的是代码与评审资料，没有部署公网阅读服务。

## 当前功能

| 部分        | 已实现的行为                                                                           |
| ----------- | -------------------------------------------------------------------------------------- |
| 书库 / 常读 | 搜索、分类、常读筛选、继续阅读；卡片复用保留焦点，点击后进入独立阅读页                 |
| 导入与处理  | 多文件导入、逐本解析开关、后台任务面板、同文件去重；原文件副本留在本机                 |
| EPUB        | 读取 OPF spine、EPUB 3 nav / EPUB 2 NCX；保留正文、插图、样式、脚注和内部链接          |
| TXT         | 中文章 / 回 / 卷、英文 Chapter / Part / Book 共用规则；支持 UTF-8、UTF-16 BOM、GB18030 |
| PDF         | 保留原版面；原有书签与文字层优先，不足时按页 OCR；扫描目录识别及印刷页码映射           |
| 阅读方式    | 文字书默认轻滑与淡入淡出的分页；PDF 默认连续滚动；可切换分页 / 滚动                    |
| 位置与书签  | 目录搜索、跳转返回、同章多个书签；保存段落及字符锚点，排版变化后恢复内容位置           |
| 取用内容    | 划词后复制或打开带出处的提问草稿；EPUB 图片 / 表格 / MathML 可完整取用                 |
| 字体与主题  | 中英文分别选字体，调字号 / 行距 / 宽度，四种主题，专注模式和计时                       |
| 掌上阅读    | 真实 macOS NSPanel，默认置顶；窗口缩小时同步缩放字号，独立保存浏览方式并共享阅读位置   |

### 支持的导入格式

| 格式                               | 路径                                              | 文档解析默认值 |
| ---------------------------------- | ------------------------------------------------- | -------------- |
| EPUB                               | 原生读取原书结构，不先转为 TXT                    | 关             |
| PDF                                | 原有结构优先，OCR 增强缺失能力                    | 开             |
| TXT                                | 统一章节规则，关闭时按全文阅读                    | 开             |
| MOBI / AZW / AZW3                  | 本地解包可直接读取的文件，接入 EPUB / HTML 阅读器 | 关             |
| FB2 / MD / HTML / DOCX / ODT / RTF | Pandoc 本地转换，再进入相同的阅读链路             | 关             |
| CBZ                                | 按文件数字顺序读取图像页                          | 关             |

开关可在导入时或书籍设置中调整。EPUB 关闭增强解析仍保留原有目录和插图。格式适配不代表所有厂商变体均已验证；加密 / 受保护文件不在直接读取范围内。

## 本轮改进（2.13）

书库合并常读筛选，导入状态移到按需打开的任务面板。星标操作保留卡片与键盘焦点；通知支持语义反馈和撤销。四种主题的辅助文字达到 AA 对比度，正文颜色达到 AAA，封面、遮罩和光影使用语义变量。保留字符锚点分页与个人排印偏好。

| 夜间书库                                            | 空状态与继续行动                            |
| --------------------------------------------------- | ------------------------------------------- |
| ![匿名夜间书库](docs/screenshots/library-night.png) | ![无结果空状态](docs/screenshots/empty.png) |

[常读撤销反馈](docs/screenshots/feedback.png) · [章节失败与重试](docs/screenshots/retry.png)

## 页面与交互预览

下列画面均来自同一套可运行的匿名演示，而非设计稿或真实阅读资料。

| 沉浸阅读                                 | 阅读设置                                         |
| ---------------------------------------- | ------------------------------------------------ |
| ![示例阅读](docs/screenshots/reader.png) | ![字体与主题设置](docs/screenshots/settings.png) |

| 扫描 PDF 划词提问                                        | 导入选项                                         |
| -------------------------------------------------------- | ------------------------------------------------ |
| ![扫描示例 PDF 选择](docs/screenshots/pdf-selection.png) | ![逐本文档解析开关](docs/screenshots/import.png) |

| 掌上窗口                                   | 导入与处理                                |
| ------------------------------------------ | ----------------------------------------- |
| ![原生掌上阅读](docs/screenshots/palm.png) | ![处理状态](docs/screenshots/imports.png) |

翻页改为约 480 ms 的轻缓位移与淡入淡出，保持实际正文的选择几何位置，弱化阴影。章内分页、跨章导航和掌上模式采用相近的节奏；开启系统“减少动态效果”后直接切页。特别长的未分章文档使用轻淡入，避免复制整本 DOM。

![柔和翻页实录，全部为自编示例](docs/screenshots/page-turn.gif)

### 常用操作

- `←` / `→`、`PageUp` / `PageDown`、空格：阅读翻页；也可使用触控板和底部按钮。
- `⌘K`：书库中检索书籍，阅读中检索本书目录；`⌘B`：添加 / 移除书签。
- `⌘G`：跳页；`⌘[` / `⌘]`：前后章节，PDF 为前后文件页；`Esc` 在书库中清空筛选。
- 点击页码：跳转当前章节屏幕页或 PDF 文件页序。
- `F`：专注阅读；`Esc`：收起浮层 / 退出专注。
- 阅读器顶部「掌上阅读」：打开 macOS 掌上窗口；图钉按钮切换置顶。
- 常读切换和删除书签后，可在通知中撤销；悬停或键盘聚焦通知时暂停消失计时。
- 掌上设置提供标准 `344×560` 和小巧 `280×440` 尺寸；字号随可用面积调整。

## 给评审者

请先阅读 [与评审 AI 的沟通记录](docs/REVIEW_DIALOGUE.md)：本轮建议的处理状态、源码判断校正和下一轮问题都会持续维护在这里。

- [产品范围与逐项功能](docs/FEATURES.md)：明确当前能力、交互路径和已知边界。
- [产品 / UI 评审说明与提示词](docs/PRODUCT_REVIEW.md)：适合交给产品专家和设计评审 AI。
- [代码评审说明与提示词](docs/CODE_REVIEW.md)：包含建议阅读顺序、重点风险与输出要求。
- [架构、索引与数据流](docs/ARCHITECTURE.md)：解释格式适配、PDF 选择层、分页和小窗同步。
- [验证记录](QA.md)：自动检查与本机交互验证的实际范围。
- [字体清单](FONTS.md) / [第三方资源](THIRD_PARTY_NOTICES.md)。

## 目录结构

```text
index.html             页面与对话框入口
app-v2.mjs             路由、阅读状态、目录、选择、设置及窗口同步
ui/                    复用书籍卡片、语义通知与撤销、图标和转义
page-layout.mjs        实时 DOM 分页与柔和换页动画
core.mjs               TXT 章节、编码、进度与掌上字号计算
server.py              本地 HTTP / 导入 / 任务 / 状态接口
book_import.py         格式适配与原生 EPUB 结构读取
pdf_enhancement.py     OCR、扫描目录、页码校准、区块内保守修正
paths.py               个人与演示资料隔离、运行路径
native/                Swift OCR 与 NSPanel / WKWebView 小窗
scripts/create_demo.py 原创演示 EPUB / TXT / PDF / 扫描件生成
scripts/check_publication.py 发布文件检查
assets/fonts/          阅读字体及许可证
assets/vendor/         PDF.js、WASM、CMap 及许可证
tests/                 无需私人图书的回归测试
docs/                  评审指南及匿名截图
```

## 验证

```sh
node --check app-v2.mjs
node tests/core.test.mjs
node tests/layout.test.mjs
node tests/page-turn.test.mjs
node tests/library.test.mjs
node tests/theme.test.mjs
python -m unittest discover -s tests -p '*_test.py' -v
```

准备提交时还可运行：

```sh
python scripts/check_publication.py
```

该检查读取 Git 索引中的实际待发布文件，拒绝数据目录、凭据文件、个人绝对路径和常见密钥格式。额外的本地排除词可以通过 `--deny-file` 指定，排除词文件本身不应提交。截图还需人工确认只含生成的示例资料。

## 当前边界

- AI 面板目前只准备问题与出处、支持复制；没有调用大模型或保存完整问答。
- MinerU 全书任务、全书精确公式识别、定理依赖导航、依据此前知识的辅导继续暂缓；现有增强接口不自动上传图书。
- OCR 可能出错，尤其数学公式；字符精确对齐、跨页取用及不确定性表达仍待完善。
- 后台全局翻页快捷键已注册，当前可靠验证范围为聚焦小窗的方向键；离焦触发需进一步复核。
- 特殊固定排版、竖排、多媒体 EPUB、超大文件与全部 Kindle 变体尚未全面验证。
- 存储采用本机 JSON 文件，仍需要进一步审查并发、崩溃恢复和大书的资源占用。

项目尚未指定项目级开源许可证。随仓库分发的第三方字体、PDF.js 与相关资源保留各自许可证。
