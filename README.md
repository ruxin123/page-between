# 页间 · Page Between

一个面向 macOS 的本地阅读应用。在同一个书库中阅读小说与教材：EPUB 沿用原书结构，PDF 保留原始版面并增强目录与划词，文字书支持柔和翻页，还可以放进桌面角落的掌上小窗。

[下载最新版本](https://github.com/ruxin123/page-between/releases/latest) · [全部版本](https://github.com/ruxin123/page-between/releases) · [更新日志](docs/CHANGELOG.md)

![页间书库](docs/screenshots/library.png)

## 下载与安装

当前版本 **0.5.11**，提供 Apple Silicon（arm64）安装包。

| 安装包 | 用途 |
| --- | --- |
| [页间 · 普通版](https://github.com/ruxin123/page-between/releases/download/v0.5.11/page-between-0.5.11-macos-arm64.zip) | 从空书库开始，导入自己的书籍 |
| [页间 · 演示版](https://github.com/ruxin123/page-between/releases/download/v0.5.11/page-between-demo-0.5.11-macos-arm64.zip) | 内置五本原创示例，快速体验阅读与学习功能 |

1. 下载 ZIP 并解压，将「页间.app」或「页间演示.app」拖入应用程序文件夹。
2. 打开应用，在书库点击「导入书籍」，选择文件并设置是否启用文档解析。
3. 点击封面进入阅读；需要 AI 或云解析时，再到「设置」中配置服务。

安装包包含运行组件，无需另外安装 Python、Node.js 或开发工具。普通版与演示版可以并存，书库、阅读记录与服务设置彼此独立。升级时退出应用，用新版替换旧 App，已有数据继续保留；建议升级前在设置中备份书库。

当前安装包为开发预览版，采用 ad-hoc 签名，尚未经过 Apple 公证。使用平台为 Apple Silicon、macOS 27.0.1，其他系统版本的兼容性尚未确定。

## 主要功能

### 安静阅读，自由排版

- 独立书库与阅读界面，支持分类、常读、搜索和继续阅读。
- 文字书默认分页，提供轻缓的翻页动画，也可切换连续滚动；PDF 默认连续阅读。
- 中英文字体分别选择，调整字号、行距、版心宽度，切换清纸、雾松、暮蓝与夜墨主题。
- 主窗口默认展开章节目录，支持书签、阅读进度、书内检索、跳转与返回；改变字号或窗口大小后尽量保持内容位置。

### 保留 PDF 原貌，补足内容取用

PDF 以原页为阅读主体，优先利用已有文字层与书签。扫描件可在本机 OCR，补充划词、目录与搜索；文字结果随书保存，并提前准备附近页面。已导入的 PDF 也能从「文档处理」中准备整本、暂停或继续。

可选的 MinerU 云解析提供更完整的文字、公式、表格与图像结构，支持指定页段、补全未解析页和整本分批处理。公式、表格与图片按完整对象取用；提问选段显示排版后的公式与表格，复制仍保留原始文字、LaTeX 或表格数据。

### 带出处的书内 AI 答疑

划选原文后即可翻译、解释术语或追问，也可围绕当前页面发起问题。答疑面板可以拖动，生成过程中可以继续阅读。

按需检索本书当前位置之前的资料，为回答提供参考；来源可预览、跳回原文，再返回阅读位置。支持流式回答、停止、重试和连续追问，对话与选段保存在本机。支持图像的模型还可以接收本次选中的原图。

### 掌上阅读

从阅读器打开可移动、可置顶的原生小窗，在屏幕角落继续阅读。窗口大小变化时自适应字号，与主窗口共享进度；小窗可单独记忆分页或滚动模式。

窗口聚焦时使用方向键或空格；其他 App 聚焦时，可用 **Control + Option + Command + ← / →** 后台翻页。设置中也可改用同组合键的 P / N，或关闭后台快捷键。

| 沉浸阅读 | 掌上小窗 |
| --- | --- |
| ![文字阅读](docs/screenshots/reader.png) | ![掌上阅读](docs/screenshots/palm.png) |

### 导出与数据管理

- 导出 EPUB：原生 EPUB 保留原书副本，TXT 按章节导出，PDF 将已解析内容转换为可重排正文；未解析页与复杂内容可保留原图。
- TXT 自动识别中英文章节，也可手动分章、合并与改名。
- 书库备份与恢复包含图书、进度、书签、对话及已保存的识别结果；服务凭据留在本机钥匙串。

## 支持的格式

| 格式 | 阅读方式 | 文档解析默认值 |
| --- | --- | --- |
| EPUB | 直接读取目录、正文、插图、脚注与内部链接 | 关 |
| PDF | 保留原页，按需使用本机 OCR 与 MinerU 增强 | 开 |
| TXT | 自动章节与可重排阅读 | 开 |
| MOBI / AZW / AZW3 | 本地解包后进入文字阅读器 | 关 |
| FB2 / Markdown / HTML / DOCX / ODT / RTF | 本地转换后阅读 | 关 |
| CBZ | 按顺序阅读图像页 | 关 |

导入时可逐本调整解析开关。EPUB 无需增强解析即可使用自带目录与插图；MinerU 用于需要结构增强的 PDF。转换格式采用单文件导入，图片应已内嵌或包含在文件包中。加密及 DRM 保护文件不支持直接读取，特殊固定排版或多媒体电子书可能无法完整呈现。

## 配置 AI 与 MinerU

在应用内打开「设置」即可配置，无需编辑环境变量。

| 服务 | 填写内容 | 用途 |
| --- | --- | --- |
| AI 答疑 | API 地址、模型 ID、API Key；按模型能力开启图像输入 | 支持 Chat Completions 兼容接口，用于解释、翻译和问答 |
| MinerU | API 地址、Token、解析模型 | PDF 结构解析；[获取 Token 与接口说明](https://mineru.net/apiManage/docs) |

API Key 与 Token 由 macOS 钥匙串保存。连接本机模型时可使用回环 HTTP 地址，并按服务要求留空 Key。基础阅读、导入和本机 OCR 不需要配置这些服务。

只有主动发送问题或发起云解析时，相应内容才会交给所配置的服务：AI 接收本次选段、附近文字、检索资料和选定图片；MinerU 接收选定的 PDF 页面。MinerU 支持按页数与文件大小拆分批次，已完成页面可以复用。

![应用内服务设置](docs/screenshots/services.png)

## 常用操作

| 操作 | 快捷键 / 入口 |
| --- | --- |
| 翻页 | ← / →、PageUp / PageDown、空格 |
| 搜索书籍 / 当前目录 | ⌘K |
| 书内搜索 | ⌘F |
| 跳页 | ⌘G，或点击页码 |
| 添加 / 移除书签 | ⌘B |
| 前后章节；PDF 前后文件页 | ⌘[ / ⌘] |
| 专注阅读 | F；Esc 收起浮层或退出专注 |
| 打开掌上小窗 | 阅读器顶部「掌上阅读」 |
| 小窗后台翻页 | ⌃⌥⌘← / ⌃⌥⌘→ |

## 本地数据

图书与阅读积累保存在本机，应用不会自动扫描 Apple 图书或其他私人书库。

- 普通版：`~/Library/Application Support/Page Between/Personal/`
- 演示版：`~/Library/Application Support/Page Between/Review Demo/`
- 临时缓存：`~/Library/Caches/Page Between/`

可在「设置 → 书库与数据」中备份、恢复和清理缓存。安装包及本仓库不包含个人书籍、阅读记录或凭据；页面截图使用原创演示资料。

## 从源码运行

开发环境使用 Python 3.12、Node.js 与 macOS Swift 工具链；格式转换和英文扫描件识别分别需要 Pandoc、Tesseract。

```sh
git clone https://github.com/ruxin123/page-between.git
cd page-between
brew install node pandoc tesseract
xcode-select --install
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py --demo
```

打开 [127.0.0.1:8779](http://127.0.0.1:8779/) 体验原创示例。使用 `python server.py` 启动个人书库，地址为 [127.0.0.1:8778](http://127.0.0.1:8778/)。两种模式的数据分别位于 `demo-data/` 与 `data/`，均不纳入版本控制；本地服务仅监听回环地址。

在 macOS 上构建独立 App：

```sh
python -m pip install -r requirements-build.txt
python scripts/build_app.py
# 演示版：python scripts/build_app.py --demo
```

输出目录为 `~/Library/Caches/Page Between/build/`。历史安装包、对应源码标签与逐版说明统一保存在 [GitHub Releases](https://github.com/ruxin123/page-between/releases)，日常使用直接下载安装包即可。

## 更多资料

[完整功能说明](docs/FEATURES.md) · [架构与数据流](docs/ARCHITECTURE.md) · [字体清单](FONTS.md) · [第三方资源与许可证](THIRD_PARTY_NOTICES.md)

产品与代码评审资料、[评审沟通记录](docs/REVIEW_DIALOGUE.md) 和 [开发验证记录](QA.md) 单独维护。项目尚未指定项目级开源许可证，第三方资源遵循各自许可证。
