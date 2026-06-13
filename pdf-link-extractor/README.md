# PDF Link Extractor — Chrome Extension (Manifest V3)

> 在 Chrome 中打开 PDF 文件，点击扩展图标，一键提取所有网页链接。

---

## 功能特性

- ✅ 提取 PDF 内的所有 `http/https` 链接（注解链接 + 纯文本链接双重检测）
- ✅ 显示每个链接所在页码
- ✅ 支持过滤/搜索链接
- ✅ 一键复制完整 JSON 结果
- ✅ 导出 JSON 文件
- ✅ 逐条复制单个链接

## 输出数据结构

```json
{
  "filename": "example.pdf",
  "links": [
    { "link": "https://example.com", "pageNumber": 1 },
    { "link": "https://github.com/mozilla/pdf.js", "pageNumber": 3 }
  ]
}
```

---

## 安装步骤

### 第一步：下载 pdf.js 依赖

```bash
chmod +x setup.sh
./setup.sh
```

或手动下载（版本 3.11.174）：

| 文件 | URL |
|------|-----|
| `lib/pdf.min.js` | https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js |
| `lib/pdf.worker.min.js` | https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js |

### 第二步：加载扩展

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目文件夹

### 第三步：使用

1. 在 Chrome 中打开任意 PDF 文件（`file://` 或 `https://` 均可）
2. 点击工具栏中的 🔴 扩展图标
3. 等待解析完成，查看所有链接

> **注意**：若打开本地 `file://` PDF，需在扩展管理页面为该扩展开启「允许访问文件网址」。

---

## 项目结构

```
pdf-link-extractor/
├── manifest.json          # MV3 清单文件
├── background.js          # Service Worker
├── popup.html             # 弹窗 UI
├── popup.js               # 核心逻辑（链接提取 + 渲染）
├── setup.sh               # 一键下载依赖脚本
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── lib/                   # ← 运行 setup.sh 后生成
    ├── pdf.min.js
    └── pdf.worker.min.js
```

---

## 技术实现

### 链接提取双重策略

```
PDF 文件
  │
  ├── [注解层] getAnnotations()
  │     └── ann.url / ann.unsafeUrl  ← 超链接注解（点击区域）
  │
  └── [文本层] getTextContent()
        └── 正则匹配 https?://...    ← 纯文本中的 URL
```

### 正则表达式

```js
/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi
```

### 去重机制

以 `"url::pageNumber"` 为 key，使用 `Set` 去重，同一链接在同一页只记录一次。

---

## 权限说明

| 权限 | 用途 |
|------|------|
| `activeTab` | 获取当前标签页 URL |
| `scripting` | 向 PDF 页面注入 pdf.js 并执行解析 |
| `host_permissions: <all_urls>` | 支持任意域名下的 PDF（含本地文件需额外授权） |
