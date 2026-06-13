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
//  URL 提取核心逻辑
//
//  背景：pdf.js getTextContent() 返回 items 数组，每个 item 是一小段文字。
//  长 URL 可能被切成多个相邻 item（同行）或跨行 item。
//
//  旧方案（join(" ")）的问题：
//    ① 同行紧邻 item 插入空格 → URL 被空格截断
//    ② 跨行续接过于激进 → 多个独立 URL 被粘连
//
//  新方案：状态机，以"http(s)://"为 URL 开始标志，逐 item 追踪：
//    - 遇到 http → 结束当前 URL，开始新 URL
//    - 同行紧邻 → 直接追加（无空格）
//    - 跨行且当前 URL 末尾"不完整" → 续接（去可能的断行连字符）
//    - 跨行且当前 URL 末尾"完整"   → 结束当前 URL，忽略非 URL 行首内容
//
// ════════════════════════════════════════════════════════════════════════════

// 判断两个相邻 item 是否在同一行且 x 坐标紧邻
function isAdjacentSameLine(prev, cur, threshold = 2) {
  const sameY = Math.abs(cur.transform[5] - prev.transform[5]) < 1;
  const prevRight = prev.transform[4] + (prev.width ?? 0);
  const xGap = cur.transform[4] - prevRight;
  return sameY && xGap <= threshold;
}

// 判断当前积累的 URL 末尾是否"看起来完整"（不像被截断）
// 完整：末尾是字母/数字，且不以 "-" 结尾（连字符通常意味着断行截断）
function urlLooksComplete(s) {
  return /[a-zA-Z0-9]$/.test(s) && !/-$/.test(s);
}

// 把 item.str 按所有 http(s):// 位置切割成段
// 返回：[{ isStart: bool, text: string }, ...]
// 例："foo https://a.com bar https://b.com baz"
//   → [{isStart:false,text:"foo "}, {isStart:true,text:"https://a.com bar "},
//      {isStart:true,text:"https://b.com baz"}]
// 注意：isStart=true 的 text 包含从 http 到下一个 http（或末尾）之间的所有内容
function splitAtHttpStarts(str) {
  const parts = [];
  const re = /https?:\/\//gi;
  const matches = [...str.matchAll(re)];

  if (matches.length === 0) {
    parts.push({ isStart: false, text: str });
    return parts;
  }

  if (matches[0].index > 0) {
    parts.push({ isStart: false, text: str.slice(0, matches[0].index) });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end   = i + 1 < matches.length ? matches[i + 1].index : str.length;
    parts.push({ isStart: true, text: str.slice(start, end) });
  }

  return parts;
}

// 主函数：从 items 中提取所有 URL
function extractUrlsFromItems(items) {
  const found = [];   // 最终结果
  let buf = null;     // 当前正在积累的 URL 字符串，null 表示不在 URL 中

  function flush() {
    if (buf !== null) {
      // 去除末尾标点（保留字母/数字/斜杠结尾的部分）
      const cleaned = buf.replace(/[.,;:!?)>\]»]+$/, "");
      if (/^https?:\/\/.{4,}/.test(cleaned)) {
        found.push(cleaned);
      }
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

    // ── 换行时：决定是否续接当前 buf ────────────────────────────────────────
    if (newLine && buf !== null) {
      // 情况1：末尾是 "-"（PDF 断词符），且当前行首是合法 URL 字符 → 去"-"后续接
      if (/-$/.test(buf) && /^[-a-zA-Z0-9@:%._+~#?&/=]/.test(str) && !/^https?:\/\//i.test(str)) {
        buf = buf.slice(0, -1);
        // 继续往下处理（不 flush）
      }
      // 情况2：末尾看起来不完整，且行首是合法 URL 字符，且不是新 URL → 续接
      else if (!urlLooksComplete(buf) && /^[-a-zA-Z0-9@:%._+~#?&/=]/.test(str) && !/^https?:\/\//i.test(str)) {
        // 续接，继续往下处理
      }
      // 情况3：其他 → flush，以新状态处理当前 item
      else {
        flush();
      }
    }

    // ── 处理当前 item（可能含有 http 起始）──────────────────────────────────
    const parts = splitAtHttpStarts(str);

    for (const part of parts) {
      if (part.isStart) {
        // 遇到新的 URL 起始 → flush 旧的，开始新 URL
        flush();
        buf = part.text;
      } else {
        // 非 URL 起始的文本段
        if (buf !== null) {
          // 追加到当前 URL（可能是 URL 后面的后缀，也可能是下一 item 的续接）
          buf += part.text;
        }
        // 如果不在 URL 中，忽略普通文本
      }
    }
  }

  flush();
  return found;
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
    const pageLinks = [];

    // ── 方式 1: 注解层超链接（最准确，优先处理）─────────────────────────────
    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      const raw = (ann.url || ann.unsafeUrl || "").trim();
      if (raw && /^https?:\/\//i.test(raw)) {
        const key = `${raw}||${p}`;
        if (!seen.has(key)) {
          seen.add(key);
          pageLinks.push(raw);
          links.push({ link: raw, pageNumber: p });
        }
      }
    }

    // ── 方式 2: 文本层状态机扫描 ─────────────────────────────────────────────
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(i => typeof i.str === "string");

    // Debug：输出 items 原始内容
    console.group(`Page ${p} — items[${items.length}]`);
    items.forEach((it, idx) => {
      const x = it.transform[4].toFixed(1);
      const y = it.transform[5].toFixed(1);
      const w = (it.width ?? 0).toFixed(1);
      console.log(`  [${idx}] x=${x} y=${y} w=${w} | ${JSON.stringify(it.str)}`);
    });

    const urlsFromText = extractUrlsFromItems(items);
    console.log("🔍 文本层提取 URLs:", urlsFromText);

    for (const url of urlsFromText) {
      const key = `${url}||${p}`;
      if (!seen.has(key)) {
        seen.add(key);
        pageLinks.push(url);
        links.push({ link: url, pageNumber: p });
      }
    }

    if (pageLinks.length) {
      console.log("✅ 本页最终链接:", pageLinks);
    } else {
      console.log("— 无链接");
    }
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
