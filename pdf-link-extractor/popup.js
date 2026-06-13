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

// ── Core: extract links using pdf.js loaded in popup context ─────────────────
async function extractLinks(pdfUrl) {
  // pdfjsLib is available globally because popup.html loads lib/pdf.min.js
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error("pdf.js 未就绪，请确认 lib/pdf.min.js 已正确放置。");

  // Point worker to the local copy inside the extension
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

  // Fetch the PDF — popup has extension origin, so cross-origin PDFs may need CORS.
  // For Chrome's built-in viewer the tab URL IS the raw PDF URL, fetch works fine.
  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error(`无法获取 PDF (HTTP ${resp.status})`);
  const data = await resp.arrayBuffer();

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const links = [];
  const seen  = new Set();

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    // ── 方式 1: 注解层超链接 ─────────────────────────────────────────────────
    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      const raw = ann.url || ann.unsafeUrl || "";
      const url = raw.trim();
      const key = `${url}||${p}`;
      if (url && /^https?:\/\//i.test(url) && !seen.has(key)) {
        seen.add(key);
        links.push({ link: url, pageNumber: p });
      }
    }

    // ── 方式 2: 文本层正则扫描 ───────────────────────────────────────────────
    const textContent = await page.getTextContent();
    const text = textContent.items.map(i => i.str).join(" ");
    for (const m of text.matchAll(URL_REGEX)) {
      const url = m[0].replace(/[.,;:!?)>]+$/, "");
      const key = `${url}||${p}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ link: url, pageNumber: p });
      }
    }
  }

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
