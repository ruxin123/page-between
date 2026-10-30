# iPhone 开发检查

当前最低版本 iOS 17，iPhone 单窗口原生客户端。用户已选择连接 Mac 安装，设备与签名准备稍后进行。

## 已完成的本地检查

- 生产 SwiftUI、Readium 和服务代码在 iPhone arm64 SDK 下编译并链接。
- Swift 核心测试：文件去重、重启恢复、删除恢复、路径边界、损坏目录保护、对话出处及对象元数据、分章、长篇 Unicode、编码与 XML 控制字符、公式恢复、选段映射、长选段拆分和请求边界。
- 生产 TXT → EPUB 写入器重复转换、ZIP 结构与 XHTML XML 检查；EPUBCheck 5.4.0 无错误、无警告。
- WebKit 390 × 844 手机视口：矩阵、分段函数、空集与行内公式显示；部分公式复制保留源码；不安全 HTML 与远程图片过滤；内容高度可缩小。

2026-10-30 已在本机 Xcode 27 / iPhone 17 / iOS 27 模拟器中完整构建、启动并通过原生 UI 测试：导入、设置、章节跳转、正文可见性、重新打开恢复、书签、字号调整、长按选词、原生答疑窗口中的选段显示，以及关闭后重新提问同一选段。已实际检查书库、正文和选段窗口截图。离线 Readium、Markdown、KaTeX 资源的 App 打包检查通过。

本轮发现并修正字号单位错误：Readium 用 1.0 表示 100%，直接传入 100 会把正文放大并排到屏幕外。测试现在同时检查正文尺寸与可见性，不能仅凭辅助功能树中存在文字判为阅读正常。点按工具栏收起另延后处理，避免长按选词引起重排；触控翻页使用原生滑动和底栏按钮。

GitHub 工作流另在独立 iPhone 模拟器执行完整构建；本机模拟器验收不等于真机安装及所有系统版本均已验收。

## 执行方式

```sh
swift test --package-path ios
python3 ios/scripts/check_sdk.py
python3 ios/Tests/verify_ocr.py
python3 ios/Tests/verify_mineru.py
node ios/Tests/verify_markdown.cjs
python3 ios/Tests/verify_epub.py --epubcheck /path/to/epubcheck.jar
xcodebuild test -project ios/PageBetween.xcodeproj -scheme PageBetween \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
```

Markdown 检查依赖 Playwright WebKit。更新排版资源运行 `python3 ios/scripts/prepare_web.py`，下载前验证 npm 元数据的 SHA-512 完整性。

UI 测试仅在 Debug 且设置 `PAGE_BETWEEN_UI_TEST=1`、`PAGE_BETWEEN_PDF_UI_TEST=1` 或 `PAGE_BETWEEN_PDF_OBJECT_UI_TEST=1` 时生成原创 TXT 或 PDF，经生产导入链路进入书库；不会删除现有书库，不读取本机个人数据。对象示例用显式原创数据生成解析区块，不伪称云端结果。`PAGE_BETWEEN_AI_UI_TEST=1` 仅在 Debug 接入内存 URLProtocol 示例服务，不读取服务密钥、不修改保存的配置。正常启动和 Release 不创建示例，截图为原创内容。测试不会发送真实模型或翻译请求。

## 功能边界

- 扫描 PDF 的 Vision OCR、文字几何、不可见文字层、原图像素保持、持久复用通过生产链路检查；原生 UI 覆盖整本准备、重新准备、跨页、重开和长按提问。旋转与复杂原书仍需扩展验收。
- MinerU 生产原生 worker 通过受控 HTTPS URLProtocol 服务检查：实际上传 150／150／1 页 PDF，第二批上传确认中断后重启续作，保留同一任务编号，共完成 301 页。结果原页映射、精确 LaTeX 与 Token 隔离通过。此项不等于真实云端调用通过。
- PDF 原生字符区间映射到解析原文；原始 LaTeX 保持完整，匹配不可靠时保留原始选区。复杂教材内部抽取 600 个选段与桌面比较，599 个相同，另一个保留了桌面漏取的标题尾字；这属于算法对照，不能替代真机手势验收。公开测试只含原创数据。
- 原生 UI 覆盖完整公式、坏公式原图回退、表格和图片取用、原图复制操作与再次打开。生产 PDFKit 检查选段几何、原页裁图和持久 OCR；原生文字检测另覆盖 PDF Form XObject，并修复旧版误将图像页标为原生文字的缓存，避免将系统临时识别结果当成已保存文字层。
- 模型图像输入需要在配置中启用并在发送时勾选。结构化请求、图片数量／体积／格式边界已测试，真实多模态服务尚待验证。会话只保存原始选段、对象位置及消息，重新打开时从原 PDF 生成裁图，不持久保存 PNG。
- AI 使用当前选段与连续对话，尚不检索整本书。AI 与 Google 的真实请求仍需在手机配置服务后验证。
- AI 流式传输使用生产 URLSession 读取器，在受控 HTTPS URLProtocol 服务验证分段 UTF-8、Markdown／公式、JSON 回退、取消和提前断连；不把没有结束标记的内容算作完整回答。生成内容定期保存，停止或异常时保留部分结果，重新打开将未结束生成视作已停止。此项不等于真实云端通过。
- 原生模拟器通过长按选区、流式显示、停止、从本书记录重开和重新生成；已检查正文生成结果。针对选区回传慢于菜单构建的问题，使用公开选区回调与系统编辑菜单，保留查询与共享，并复用不落盘的 Markdown 进程数据存储。
- 翻译不写入磁盘；答疑按书保留原始 Markdown、选段与定位。
- 原书封面只生成一份有限尺寸缩略图；阅读原件与 TXT 派生 EPUB 属于书库资料。最近删除保留资料，尚无永久删除。
- EPUB 选词与手机字号调整已通过原生测试；复杂 PDF、旋转重排、后台恢复及真实手势仍需更多原书与真机验收。桌面小窗不直接移植到 iOS。
