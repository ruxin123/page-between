# 第三方资源与依赖

## 随仓库分发的资源

| 资源                 | 上游                                                                      | 许可证文件                                                                                                         |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| PDF.js 5.6.205       | [Mozilla PDF.js](https://github.com/mozilla/pdf.js)                       | [Apache 2.0](assets/vendor/pdfjs-LICENSE.txt)                                                                      |
| PDF.js CMap          | 同上                                                                      | [CMap LICENSE](assets/vendor/cmaps/LICENSE)                                                                        |
| PDF.js 标准字体      | Foxit / Liberation                                                        | [Foxit](assets/vendor/standard_fonts/LICENSE_FOXIT)、[Liberation](assets/vendor/standard_fonts/LICENSE_LIBERATION) |
| PDF.js WASM 解码组件 | PDF.js、OpenJPEG、QCMS、JBIG2                                             | `assets/vendor/wasm/` 中对应的 LICENSE 文件                                                                        |
| 思源宋体             | [Adobe Source Han Serif](https://github.com/adobe-fonts/source-han-serif) | [SIL OFL](assets/fonts/han-serif-LICENSE.txt)                                                                      |
| 思源黑体             | [Adobe Source Han Sans](https://github.com/adobe-fonts/source-han-sans)   | [SIL OFL](assets/fonts/han-sans-LICENSE.txt)                                                                       |
| 霞鹜文楷             | [LXGW WenKai](https://github.com/lxgw/LxgwWenKai)                         | [SIL OFL](assets/fonts/wenkai-OFL.txt)                                                                             |
| Literata             | [Google Fonts Literata](https://github.com/googlefonts/literata)          | [SIL OFL](assets/fonts/literata-OFL.txt)                                                                           |
| Source Serif 4       | [Adobe Source Serif](https://github.com/adobe-fonts/source-serif)         | [SIL OFL](assets/fonts/source-serif-LICENSE.md)                                                                    |

资源保留原有版权与许可证。`ReaderHanSerif` 等名称是页面内的 CSS 字体别名，没有修改字体文件中的作者信息。

Georgia 与系统字体使用操作系统已有字体，不随仓库分发。演示的抽象封面、插图、正文与 PDF 由本仓库脚本生成，不来自私人阅读资料。

## 按需安装的依赖

Python 依赖由 `requirements.txt` 声明，包括 lxml、pypdf、pypdfium2、Pillow、mobi、standard-imghdr、python-docx 和 ReportLab。Node.js、Pandoc、Tesseract、Swift 工具链由运行环境提供。请参照这些项目自身的许可证；本仓库没有将它们的授权统一替换为项目许可证。

MinerU 没有作为源码副本分发，也没有内置 API 凭据或商业教材样本。
