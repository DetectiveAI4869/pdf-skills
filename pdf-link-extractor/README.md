# PDF Link Extractor — Chrome 扩展程序 (v2.0.0)

> 在 Chrome 中打开 PDF 文件，扩展会自动在侧边栏中提取并展示所有网页链接。

---

## ✨ 功能特性

- 📌 **侧边栏常驻** — 基于 `chrome.sidePanel`，不像弹窗一样点开即关，可以一边看 PDF 一边对照链接
- 🔄 **自动响应标签页切换** — 切到任意 PDF 标签页，侧边栏自动刷新；切到非 PDF 页面，扩展图标自动禁用
- ⚡ **解析结果缓存** — 同一个 PDF 只解析一次，再次切回瞬间显示，无需重复等待
- 🔗 **双重链接提取** — 同时扫描 PDF 的**超链接注解**（点击热区）和**正文文字**中的网址，避免遗漏
- 🧩 **断行 URL 智能拼接** — 利用 PDF 文本块的字体（`fontName`）、坐标（`transform`）、换行标记（`hasEOL`）等元信息，正确还原被拆成多段、跨行排版的长链接
- 🔍 **实时过滤** — 链接较多时，输入关键字即时筛选
- 📋 **一键复制 JSON** — 复制结构化的 `{ filename, links }` 数据，方便粘贴到其他工具继续处理
- 🪶 **轻量** — 仅依赖 [mozilla/pdf.js](https://github.com/mozilla/pdf.js)，无后端、无数据上传，所有解析都在本地完成

### 输出数据结构

```json
{
  "filename": "0223_course.pdf",
  "links": [
    { "link": "https://arxiv.org/abs/2205.10643", "pageNumber": 9 },
    { "link": "https://youtu.be/UYPa347-DdE?si=jjqem3RovPq6ZTti&t=2979", "pageNumber": 10 }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `filename` | PDF 文件名（从 URL 解析） |
| `links` | 链接数组 |
| `links[].link` | 完整 URL |
| `links[].pageNumber` | 链接所在页码（从 1 开始） |

---

## 📦 安装步骤

### 第一步：获取扩展文件

下载并解压本项目，得到 `pdf-link-extractor-v2/` 文件夹。

> 项目已内置 `lib/pdf.min.js` 与 `lib/pdf.worker.min.js`（pdf.js v3.11.174），无需额外下载。

### 第二步：加载到 Chrome

1. 地址栏输入并打开 `chrome://extensions`
2. 打开右上角 **开发者模式** 开关
3. 点击 **加载已解压的扩展程序**
4. 选择 `pdf-link-extractor-v2/` 文件夹

加载成功后，工具栏会出现 PDF Link Extractor 图标。

### 第三步（可选）：允许访问本地文件

如果你需要解析 `file://` 协议打开的本地 PDF：

1. 回到 `chrome://extensions`
2. 找到 **PDF Link Extractor**，点击「详情」
3. 打开 **允许访问文件网址** 开关

### 第四步：开始使用

1. 在 Chrome 中打开任意 PDF 文件（本地 `file://` 或在线 `https://` 均可）
2. 点击工具栏中的扩展图标，打开侧边栏
3. 侧边栏会自动解析当前 PDF 并展示所有链接
4. 切换到其他 PDF 标签页，侧边栏内容会自动刷新；切到非 PDF 页面会显示等待提示

> 💡 侧边栏打开后会一直保留，即使你切换标签页也不会关闭——这正是相比 popup 模式的优势。

---

## 🖥️ 界面说明

| 区域 | 内容 |
|------|------|
| Header | 当前 PDF 文件名 |
| 摘要栏 | 链接总数 + 「复制 JSON」按钮 |
| 过滤框 | 实时按关键字筛选链接列表 |
| 链接列表 | 每条显示页码徽标 + 可点击链接 + 单条复制按钮 |
| Footer | 项目 GitHub 链接 |

---

## 🛠️ 技术实现

### 整体架构

```
manifest.json (MV3)
  ├── background.js   — Service Worker
  │     ├── 监听 tabs.onActivated / onUpdated / onRemoved
  │     ├── 动态 enable/disable 扩展图标（仅 PDF 标签页可用）
  │     └── 向 sidepanel 广播 TAB_CHANGED 消息
  │
  └── sidepanel.html / sidepanel.js  — 侧边栏 UI + 解析逻辑
        ├── 内嵌加载 lib/pdf.min.js（pdf.js 运行在侧边栏自身上下文）
        ├── fetch(pdfUrl) 获取 PDF 字节并用 pdf.js 解析
        └── 收到 TAB_CHANGED → 按 URL 缓存命中或重新解析
```

### 链接提取双重策略

```
PDF 文件
  ├── [注解层] page.getAnnotations()
  │     └── ann.url / ann.unsafeUrl   ← 超链接热区（最可靠）
  │
  └── [文本层] page.getTextContent()
        └── concatTextContent(items)  ← 正文文字中的纯文本 URL
```

### `concatTextContent` — 断行 URL 智能拼接

`getTextContent()` 返回的 `items` 是 PDF 渲染时按字形切割的文字块，长 URL 经常被拆成多个相邻或跨行的 item。本函数以 `https?://` 作为起点，向后合并满足以下条件的 item：

```js
if (next.fontName !== head.fontName) break;
// 字体变化 → 切到了非 URL 内容（如中文说明文字）

if (next.hasEOL === true && next.transform[4] !== head.transform[4]) break;
// 真正换行（新段落，x 坐标不对齐）→ 停止；
// 若是同一 URL 跨行折回（x 坐标对齐），则继续拼接

if (urlInvalidCharRegex.test(next.str)) break;
// 出现非 URL 合法字符（中文、括号等）→ 停止
```

这套规则利用 PDF 排版的语义信息（字体、坐标、换行标记），而非简单的字符正则猜测，能正确处理：
- 同行被拆成多段的长 URL
- 跨行折行续接的 URL
- URL 后紧跟无空格分隔的中文说明文字

### Debug 模式

`sidepanel.js` 顶部的 `debugPages` 数组用于快速排查特定页码的解析问题：

```js
// 设置需要调试的页码，例如 [6, 10, 19]；空数组 [] 表示不输出
const debugPages = [10, 19];
```

设置后，打开侧边栏的开发者工具（右键侧边栏 → 检查），Console 会输出该页所有 `items` 的详情：

```
Page 10 — items[42]
  [0] x=54.0 y=720.3 w=180.2 | "https://youtu.be/UYPa347-" | Helvetica
  [1] x=234.0 y=720.3 w=95.1 | "DdE?si=jjqem3RovPq6ZTti"   | Helvetica
  ...
```

---

## 📁 项目结构

```
pdf-link-extractor-v2/
├── manifest.json          # MV3 清单（sidePanel 模式）
├── background.js          # Service Worker：图标状态 + 标签页监听
├── sidepanel.html         # 侧边栏 UI
├── sidepanel.js           # 核心逻辑：链接提取 + 渲染 + 缓存
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── lib/                   # pdf.js（已内置）
    ├── pdf.min.js
    └── pdf.worker.min.js
```

---

## 🔐 权限说明

| 权限 | 用途 |
|------|------|
| `tabs` | 获取当前标签页 URL，监听标签页切换事件 |
| `sidePanel` | 启用侧边栏模式 |
| `host_permissions: <all_urls>` | 支持任意域名下的 PDF（本地文件需额外授权，见安装步骤） |

本扩展**不会**将 PDF 内容上传到任何服务器，所有解析均在浏览器本地完成。

---

## 🔗 项目地址

[github.com/DetectiveAI4869/pdf-skills/tree/main/pdf-link-extractor](https://github.com/DetectiveAI4869/pdf-skills/tree/main/pdf-link-extractor)
