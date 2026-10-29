# 页间 · iPhone

原生 SwiftUI iPhone 客户端，面向 iOS 17 及以上。书籍和进度保存在手机，通过 Readium 阅读 EPUB、TXT 转换后的 EPUB、PDF 与 CBZ；不依赖 Mac 或本地 Python 服务。

当前为开发版本，已完成 iPhone arm64 代码编译与链接，尚未完成模拟器／真机运行验收，不能将源码编译通过视为安装包已交付。安装方式按用户要求稍后确定。

## 当前代码

- 书库、原书封面、搜索、常读、文件导入、最近删除和恢复；相同文件按内容去重。
- EPUB 原书目录和插图；TXT 自动分章、编码检测与长篇拆分；PDF 原页阅读。
- 触控翻页、连续滚动、目录跳转和返回、书签、进度保存、字号、字体与纸张设置。
- 系统划词菜单中的提问／翻译；AI 与 Google 翻译、独立翻译模型配置。
- Markdown 和 LaTeX 显示，复制保留源码；服务密钥使用本机钥匙串，翻译不自动保存。
- 答疑按书保存选段、出处与连续对话，可回看并返回原文；关闭弹窗后可再次打开最近选段。

扫描 PDF 的本机 OCR、MinerU 整书增强、完整书内知识检索及跨设备同步仍需适配；手机浮窗不能直接沿用 macOS 掌上窗口。上述内容不应在验收前标为已实现。

## 用 Xcode 打开

打开 `PageBetween.xcodeproj`，选择 `PageBetween` Scheme 和 iPhone 模拟器。Swift Package Manager 会解析固定的 Readium 3.11.1 与 ReadiumZIPFoundation 3.0.1，以及已锁定的依赖。

```sh
xcodebuild -resolvePackageDependencies -project ios/PageBetween.xcodeproj -scheme PageBetween
xcodebuild -project ios/PageBetween.xcodeproj -scheme PageBetween \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

连接真机或通过 TestFlight 分发时，再在 Xcode 的 Signing & Capabilities 中选择自己的开发团队。不要把签名证书、描述文件或服务密钥提交到仓库。

排版依赖已随源码保存，离线阅读时不从 CDN 加载代码。密钥不随书籍导出或上传。

开发验证与当前限制见 [QA](QA.md)。GitHub 的 “iPhone build and reading flow” 工作流在独立模拟器中打包并运行原创示例，不读取开发电脑上的真实书籍与服务配置。
