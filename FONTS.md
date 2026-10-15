# 阅读字体

字体随原型保存在 `assets/fonts/`，网页从本地加载；没有安装到 macOS 系统。中文、英文分别选择，混排时各用对应字体。原 PDF 保留印刷字体，字体设置影响可重排的分页／滚动正文。

| 选择项         | 使用方向                         | 文件             | 来源与许可证                                                                            |
| -------------- | -------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| 思源宋体       | 中文小说、长篇正文；默认中文字体 | han-serif.otf    | [Adobe Source Han Serif](https://github.com/adobe-fonts/source-han-serif)，SIL OFL 1.1  |
| 霞鹜文楷       | 想要较柔和笔意的中文阅读         | wenkai.ttf       | [LXGW WenKai](https://github.com/lxgw/LxgwWenKai)，v1.522，SIL OFL 1.1                  |
| 思源黑体       | 偏好无衬线字体的阅读者           | han-sans.otf     | [Adobe Source Han Sans](https://github.com/adobe-fonts/source-han-sans)，SIL OFL 1.1    |
| Literata       | 英文长篇正文；默认英文字体       | literata.ttf     | [Google Fonts Literata](https://github.com/googlefonts/literata)，可变字体，SIL OFL 1.1 |
| Source Serif 4 | 英文教材、正文的另一种衬线选择   | source-serif.ttf | [Adobe Source Serif](https://github.com/adobe-fonts/source-serif)，SIL OFL 1.1          |
| Georgia        | 使用设备已有的英文衬线字体       | 不附带字体文件   | macOS 自带字体；不打包或再分发                                                          |
| 系统字体       | 使用设备的默认字体               | 不附带字体文件   | macOS 系统字体；不打包或再分发                                                          |

每个下载字体的完整许可证已随文件保存，可在原型中直接切换比较。

原型支持 16–30 px 字号、1.5–2.4 行距、480–860 px 正文宽度；默认 21 px / 1.95 / 680 px。切换字体会等待实际字体加载，并保持当前段落位置。四个主题为清纸、雾松、暮蓝、夜墨。掌上窗口会按可用面积自动缩放字号，可另外调整字号偏好。
