// popup.js — pdf.js 在 popup 自身上下文中运行，不注入到任何页面

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

// ════════════════════════════════════════════════════════════════════════════
//  URL 提取核心 — 状态机 + 字符级边界检测
//
//  PDF getTextContent() 的 items 特点：
//    · 长 URL 被拆成多个相邻 item（同行紧邻 / 跨行续接）
//    · URL 后面可能紧跟中文、括号等非 URL 字符，没有任何分隔
//    · 同行多个独立 URL 之间可能只靠 x 坐标区分
//
//  解决策略：
//    1. 以 "https?://" 为 URL 开始信号，遇到就 flush 旧 URL、开启新 URL
//    2. 追加 item 字符时逐字符扫描——遇到首个非 URL 字符立即截断（不吞入）
//    3. # fragment：只有 URL 里已含 ? 或路径深度 > 2 时才是合法 fragment，
//       否则（如幻灯片编号 #5516348）截断
//    4. 换行时：仅当 buf 末尾"不完整"（以 - 或非字母数字结尾）才续接下一行
//
// ════════════════════════════════════════════════════════════════════════════

// URL 合法字符（不含 #，# 单独处理）
const URL_CHAR_RE = /[-a-zA-Z0-9@:%._+~?&/=]/;

function isAdjacentSameLine(prev, cur, threshold = 2) {
  const sameY = Math.abs(cur.transform[5] - prev.transform[5]) < 1;
  const prevRight = prev.transform[4] + (prev.width ?? 0);
  return sameY && (cur.transform[4] - prevRight) <= threshold;
}

function urlLooksComplete(s) {
  // 末尾是字母/数字且不以 - 结尾 → 视为完整，不续接下一行
  return /[a-zA-Z0-9]$/.test(s) && !s.endsWith("-");
}

// 从 str[offset] 开始逐字符追加合法 URL 字符到 buf。
// 遇到新 https?:// 或非 URL 字符时停止。
// 返回 { buf, stopIdx }：stopIdx=-1 表示消费完整个剩余字符串。
function appendUrlChars(buf, str, offset) {
  for (let i = offset; i < str.length; i++) {
    const ch = str[i];

    // 遇到新 URL 起始 → 停止（调用方负责 flush + 开新 URL）
    if (/^https?:\/\//i.test(str.slice(i))) {
      return { buf, stopIdx: i };
    }

    // # 号：判断是否是合法 fragment
    if (ch === "#") {
      const hasQuery  = buf.includes("?");
      const slashCount = (buf.match(/\//g) || []).length;
      // https:// 本身含 2 个斜杠；slashCount > 2 → 有路径层级
      if (!hasQuery && slashCount <= 2) {
        return { buf, stopIdx: i }; // 当做锚点/编号，截断
      }
    }

    // 非法字符（中文、空格、括号等）→ 截断
    if (!URL_CHAR_RE.test(ch) && ch !== "#") {
      return { buf, stopIdx: i };
    }

    buf += ch;
  }
  return { buf, stopIdx: -1 };
}

function extractUrlsFromItems(items) {
  const found = [];
  let buf = null; // null = 不在 URL 中

  function flush() {
    if (buf !== null) {
      const cleaned = buf.replace(/[.,;:!?)>\]»]+$/, "");
      if (/^https?:\/\/[^\s]{4,}/.test(cleaned)) found.push(cleaned);
      buf = null;
    }
  }

  for (let i = 0; i < items.length; i++) {
    const cur  = items[i];
    const prev = items[i - 1];
    const str  = cur.str;
    if (!str) continue;

    const adjacent = prev && isAdjacentSameLine(prev, cur);
    const newLine  = prev && !adjacent;

    // ── 换行处理 ────────────────────────────────────────────────────────────
    if (newLine && buf !== null) {
      const firstCh = str[0] ?? "";
      const isNewUrl = /^https?:\/\//i.test(str);

      if (!isNewUrl && buf.endsWith("-") && URL_CHAR_RE.test(firstCh)) {
        // PDF 断词连字符：去 "-" 续接
        buf = buf.slice(0, -1);
      } else if (!isNewUrl && !urlLooksComplete(buf) && URL_CHAR_RE.test(firstCh)) {
        // URL 末尾不完整：续接
      } else {
        // URL 完整 或 下一行是新 URL 或 非 URL 字符开头：flush
        flush();
      }
    }

    // ── 逐字符处理当前 item ──────────────────────────────────────────────────
    let offset = 0;
    while (offset < str.length) {
      if (/^https?:\/\//i.test(str.slice(offset))) {
        // 新 URL 起始
        flush();
        buf = "";
        const r = appendUrlChars(buf, str, offset);
        buf = r.buf;
        if (r.stopIdx === -1) { offset = str.length; }
        else { offset = r.stopIdx; flush(); }
      } else if (buf !== null) {
        // 在 URL 中，继续追加
        const r = appendUrlChars(buf, str, offset);
        buf = r.buf;
        if (r.stopIdx === -1) { offset = str.length; }
        else { offset = r.stopIdx; flush(); }
      } else {
        // 不在 URL 中，跳过
        offset++;
      }
    }
  }

  flush();
  return found;
}

// ── Core: extract links ───────────────────────────────────────────────────────
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

  console.group(`PDF Link Extractor — ${pdfUrl}`);
  console.log(`总页数: ${pdf.numPages}`);

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const pageLinks = [];

    // 方式 1：注解层（最准确）
    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      const raw = (ann.url || ann.unsafeUrl || "").trim();
      if (raw && /^https?:\/\//i.test(raw)) {
        const key = `${raw}||${p}`;
        if (!seen.has(key)) { seen.add(key); pageLinks.push(raw); links.push({ link: raw, pageNumber: p }); }
      }
    }

    // 方式 2：文本层状态机
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(it => typeof it.str === "string");

    console.group(`Page ${p} — ${items.length} items`);
    items.forEach((it, idx) => {
      const x = it.transform[4].toFixed(1), y = it.transform[5].toFixed(1), w = (it.width ?? 0).toFixed(1);
      console.log(`[${idx}] x=${x} y=${y} w=${w} | ${JSON.stringify(it.str)}`);
    });

    for (const url of extractUrlsFromItems(items)) {
      const key = `${url}||${p}`;
      if (!seen.has(key)) { seen.add(key); pageLinks.push(url); links.push({ link: url, pageNumber: p }); }
    }

    console.log(pageLinks.length ? `Links: ${JSON.stringify(pageLinks)}` : "— 无链接");
    console.groupEnd();
  }

  console.log(`\n完成，共 ${links.length} 个链接`);
  console.log(JSON.stringify({ links }, null, 2));
  console.groupEnd();
  return links;
}

// ── Render ────────────────────────────────────────────────────────────────────
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
    a.click(); URL.revokeObjectURL(a.href);
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
