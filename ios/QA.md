# iPhone 开发检查

当前最低版本 iOS 17，iPhone 单窗口原生客户端。安装与签名方式后续确定。

## 已完成的本地检查

- 生产 SwiftUI、Readium 和服务代码在 iPhone arm64 SDK 下编译并链接。
- 11 项 Swift 核心测试：文件去重、重启恢复、删除恢复、路径边界、损坏目录保护、对话出处、分章、长篇 Unicode、编码与 XML 控制字符、公式恢复和请求边界。
- 生产 TXT → EPUB 写入器重复转换、ZIP 结构与 XHTML XML 检查；EPUBCheck 5.4.0 无错误、无警告。
- WebKit 390 × 844 手机视口：矩阵、分段函数、空集与行内公式显示；部分公式复制保留源码；不安全 HTML 与远程图片过滤；内容高度可缩小。

独立 Swift Package 编译不会验证 Xcode App 的资源复制与原生运行。当前本机 Xcode 缺少 CoreSimulator 等系统组件，组件安装尚未完成；GitHub 工作流另执行完整 Xcode 构建和原生 UI 测试，其结果需要独立确认。

## 执行方式

```sh
swift test --package-path ios
python3 ios/scripts/check_sdk.py
node ios/Tests/verify_markdown.cjs
python3 ios/Tests/verify_epub.py --epubcheck /path/to/epubcheck.jar
xcodebuild test -project ios/PageBetween.xcodeproj -scheme PageBetween \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
```

Markdown 检查依赖 Playwright WebKit。更新排版资源运行 `python3 ios/scripts/prepare_web.py`，下载前验证 npm 元数据的 SHA-512 完整性。

UI 测试仅在 Debug 且设置 `PAGE_BETWEEN_UI_TEST=1` 时生成原创 TXT，经生产导入链路进入书库；不会删除现有书库，不读取本机个人数据。正常启动和 Release 不创建示例。测试检查设置、章节跳转、重新打开进度和书签，截图为原创内容。

## 功能边界

- 扫描 PDF 目前只显示原页；设备 OCR、MinerU 解析和公式区块取用尚未移植。设置不展示未接通的服务。
- AI 使用当前选段与连续对话，尚不检索整本书。AI 与 Google 的真实请求仍需在手机配置服务后验证。
- 翻译不写入磁盘；答疑按书保留原始 Markdown、选段与定位。
- 原书封面只生成一份有限尺寸缩略图；阅读原件与 TXT 派生 EPUB 属于书库资料。最近删除保留资料，尚无永久删除。
- PDFKit 和 EPUB 的长按菜单、旋转重排、后台恢复及真实手势，仍需原生运行与真机验收；桌面小窗不直接移植到 iOS。
