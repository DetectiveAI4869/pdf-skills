// popup.js — pdf.js 在 popup 自身上下文中运行，不注入到任何页面

const URL_REGEX =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

const $ = (id) => document.getElementById(id);

function setContent(html) { $("content").innerHTML = html; }
function setFilename(name) { $("header-filename").textContent = name || "未知文件"; }

function isPdfUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith(".pdf") || u.href.toLowerCase().includes(".pdf");
  } catch { return false; }
}

function getFilename(url) {
  try {
    const parts = new URL(url).pathname.split("/");
    return decodeURIComponent(parts[parts.length - 1]) || url;
  } catch { return url; }
}

function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
            .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function renderError(msg) {
  setContent(`<div class="error-box">⚠️ ${msg}</div>`);
}

// ── 智能文本拼接：处理 PDF 文本层 item 间的 URL 断行 ───────────────────────
//
// PDF 的 getTextContent() 返回若干 item，每个 item 有：
//   - str      : 文字内容
//   - transform: [scaleX, skewY, skewX, scaleY, x, y] 左下角坐标
//   - width    : item 渲染宽度（字体单位）
//   - hasEOL   : 是否行末
//
// 问题根源：长 URL 在 PDF 排版时被拆成多个连续 item（或跨行），
// 简单 join(" ") 会把 URL 中间插入空格导致截断。
//
// 修复策略：判断相邻两个 item 是否"无缝衔接"，若是则直接拼接（不加空格）：
//   1. 同一行（y 坐标相同），且前一 item 的右边缘 ≈ 当前 item 左边缘
//   2. 当前行首 item 的内容像是上一行末 URL 的续接
//      （上一行末尾不含空格结尾，且当前首字符是 URL 合法字符，非大写字母开头新词）
//
function buildSmartText(items) {
  if (!items.length) return "";

  // 容差：x 坐标差值在此范围内认为"紧邻"（字体单位，约 1-2 个字符宽）
  const X_GAP_THRESHOLD = 2;

  let result = "";

  for (let i = 0; i < items.length; i++) {
    const cur  = items[i];
    const prev = items[i - 1];
    const str  = cur.str;

    if (i === 0) {
      result += str;
      continue;
    }

    const curX   = cur.transform[4];
    const curY   = cur.transform[5];
    const prevX  = prev.transform[4];
    const prevY  = prev.transform[5];
    const prevW  = prev.width ?? 0;
    const prevR  = prevX + prevW;          // 前一 item 右边缘 x
    const xGap   = curX - prevR;           // 当前 item 左边缘与前一 item 右边缘的间距
    const sameY  = Math.abs(curY - prevY) < 1;

    // ── 情况 A：同一行，x 坐标紧邻（间距极小）→ 直接拼接 ──────────────────
    if (sameY && xGap <= X_GAP_THRESHOLD) {
      result += str;
      continue;
    }

    // ── 情况 B：跨行续接 URL ───────────────────────────────────────────────
    // 条件：
    //   - 前一行末尾看起来像 URL 片段（包含 http 或末尾是 URL 合法字符且无空格）
    //   - 当前行首字符是 URL 合法字符（非空格、非大写开头的新词）
    const prevTail = result.trimEnd();
    const inUrl    = /https?:\/\/\S+$/.test(prevTail);  // result 末尾有未结束的 URL
    const curHead  = str.trimStart()[0] ?? "";
    const isUrlContinuation =
      inUrl &&
      /^[-a-zA-Z0-9@:%._+~#?&/=]/.test(curHead) &&  // 首字符合法
      !/^[A-Z][a-z]/.test(str.trimStart());           // 排除"新句子"（首字母大写接小写）

    if (isUrlContinuation) {
      // 去掉前一行可能残留的断行连字符 "-"（PDF 常见断词符号）
      if (result.endsWith("-")) {
        result = result.slice(0, -1);
      }
      result += str.trimStart();
      continue;
    }

    // ── 默认：插入空格分隔 ────────────────────────────────────────────────
    result += " " + str;
  }

  return result;
}

// ── Core: extract links using pdf.js loaded in popup context ─────────────────
async function extractLinks(pdfUrl) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error("pdf.js 未就绪，请确认 lib/pdf.min.js 已正确放置。");

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error(`无法获取 PDF (HTTP ${resp.status})`);
  const data = await resp.arrayBuffer();

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const links = [];
  const seen  = new Set();

  console.group(`📄 PDF Link Extractor — ${pdfUrl}`);
  console.log(`总页数: ${pdf.numPages}`);

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    // ── 方式 1: 注解层超链接（最准确，优先处理）─────────────────────────────
    const annotations = await page.getAnnotations();
    const annLinks = [];
    for (const ann of annotations) {
      const raw = (ann.url || ann.unsafeUrl || "").trim();
      if (raw && /^https?:\/\//i.test(raw)) {
        const key = `${raw}||${p}`;
        if (!seen.has(key)) {
          seen.add(key);
          links.push({ link: raw, pageNumber: p });
          annLinks.push(raw);
        }
      }
    }

    // ── 方式 2: 文本层正则扫描（智能拼接处理断行 URL）────────────────────────
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(i => i.str);

    // 智能拼接，处理 URL 断行
    const text = buildSmartText(items);

    // Debug log：输出每页拼接后的原始文本
    console.group(`Page ${p}`);
    console.log("📝 拼接文本:\n" + text);

    const textLinks = [];
    for (const m of text.matchAll(URL_REGEX)) {
      // 去除末尾标点（但保留 URL 中合法的括号等）
      let url = m[0].replace(/[.,;:!?)>»]+$/, "");
      const key = `${url}||${p}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ link: url, pageNumber: p });
        textLinks.push(url);
      }
    }

    if (annLinks.length)  console.log("🔗 注解链接:", annLinks);
    if (textLinks.length) console.log("🔍 文本链接:", textLinks);
    if (!annLinks.length && !textLinks.length) console.log("— 无链接");
    console.groupEnd();
  }

  console.log("\n✅ 提取完成，共", links.length, "个链接");
  console.log(JSON.stringify({ links }, null, 2));
  console.groupEnd();

  return links;
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderLinks(filename, links) {
  if (links.length === 0) {
    setContent(`<div class="empty">📄 已扫描完毕<br>该 PDF 中未找到任何网页链接。</div>`);
    return;
  }

  const resultJson = JSON.stringify({ filename, links }, null, 2);

  setContent(`
    <div class="summary">
      <div class="summary-count">共找到 <span>${links.length}</span> 个链接</div>
      <div class="btn-group">
        <button class="btn btn-copy" id="btn-copy">复制 JSON</button>
        <button class="btn btn-export" id="btn-export">导出 JSON</button>
      </div>
    </div>
    <div class="filter-bar">
      <input class="filter-input" id="filter-input" type="text" placeholder="过滤链接…" autocomplete="off"/>
    </div>
    <div id="link-list">
      ${links.map(({ link, pageNumber }) => `
        <div class="link-item" data-link="${escHtml(link)}">
          <span class="page-badge">P${pageNumber}</span>
          <a class="link-url" href="${escHtml(link)}" target="_blank">${escHtml(link)}</a>
          <button class="copy-one" data-link="${escHtml(link)}" title="复制">⎘</button>
        </div>`).join("")}
    </div>
    <div class="footer">PDF Link Extractor · 仅提取 http/https 链接</div>
  `);

  $("btn-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(resultJson).then(() => {
      const b = $("btn-copy");
      b.textContent = "✓ 已复制"; b.classList.add("copied");
      setTimeout(() => { b.textContent = "复制 JSON"; b.classList.remove("copied"); }, 1800);
    });
  });

  $("btn-export").addEventListener("click", () => {
    const blob = new Blob([resultJson], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `${filename.replace(/\.pdf$/i, "")}_links.json`
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.querySelectorAll(".copy-one").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.link).then(() => {
        btn.textContent = "✓";
        setTimeout(() => btn.textContent = "⎘", 1200);
      });
    });
  });

  $("filter-input").addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll(".link-item").forEach(item => {
      item.style.display = item.dataset.link.toLowerCase().includes(q) ? "" : "none";
    });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url) { renderError("无法获取当前标签页信息。"); return; }

  if (!isPdfUrl(tab.url)) {
    setFilename("非 PDF 页面");
    renderError("当前页面不是 PDF 文件。<br>请在 Chrome 中打开一个 PDF 文件后再使用此扩展。");
    return;
  }

  const filename = getFilename(tab.url);
  setFilename(filename);

  try {
    const links = await extractLinks(tab.url);
    renderLinks(filename, links);
  } catch (err) {
    console.error(err);
    renderError(err.message);
  }
})();
