// sidepanel.js — PDF Link Extractor v2.0.0

// ── 工具 ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function isPdfUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith(".pdf")
        || u.href.toLowerCase().includes(".pdf");
  } catch { return false; }
}

function getFilename(url) {
  try {
    const parts = new URL(url).pathname.split("/");
    return decodeURIComponent(parts[parts.length - 1]) || url;
  } catch { return url; }
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── PDF 解析 ──────────────────────────────────────────────────────────────────
function concatTextContent(items) {
  const pageLinks = [];            // const: 数组引用不变，push 内容
  let i = 0;
  const urlHeadRegex        = /^https?:\/\//;                          // TODO: 支持 www. 开头
  const urlInvalidCharRegex = /[^A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=]/; // TODO: 支持 () 字符

  while (i < items.length) {
    if (urlHeadRegex.test(items[i].str)) {
      const head = items[i];
      let link = head.str;
      let j = i + 1;

      while (j < items.length) {
        const next = items[j];
        if (next.fontName !== head.fontName) break;
        if (next.hasEOL === true && next.transform[4] !== head.transform[4]) break;
        if (urlInvalidCharRegex.test(next.str)) break;
        link += next.str;
        j++;
      }

      pageLinks.push(link);
      i = j;
      continue;
    }
    i++;
  }

  return pageLinks;
}

// ── Debug helpers ─────────────────────────────────────────────────────────────
// 设置 debugPages 中的页码以输出该页 items 详情，空数组 = 不输出
// 例：const debugPages = [6, 10, 19];
const debugPages = [];

function debugPageItems(p, items) {
  if (!debugPages.includes(p)) return;
  console.group(`Page ${p} — items[${items.length}]`);
  console.dir(items);
  items.forEach((item, i) => {
    const x = item.transform[4].toFixed(1);
    const y = item.transform[5].toFixed(1);
    const w = item.width.toFixed(1);
    console.log(`  [${i}] x=${x} y=${y} w=${w} | ${JSON.stringify(item.str)} | ${item.fontName}`);
  });
  console.groupEnd();
}

// ── 核心提取 ─────────────────────────────────────────────────────────────────
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

  console.log(`PDF Link Extractor — ${pdfUrl}`);
  console.log(`总页数: ${pdf.numPages}`);

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    // 方式 1：注解层（最准确，优先）
    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      const raw = (ann.url || ann.unsafeUrl || "").trim();
      if (raw && /^https?:\/\//i.test(raw)) {
        const key = `${raw}||${p}`;
        if (!seen.has(key)) { seen.add(key); links.push({ link: raw, pageNumber: p }); }
      }
    }

    // 方式 2：文本层
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(it => typeof it.str === "string");

    debugPageItems(p, items);

    for (const url of concatTextContent(items)) {
      const key = `${url}||${p}`;
      if (!seen.has(key)) { seen.add(key); links.push({ link: url, pageNumber: p }); }
    }
  }

  console.log(`总链接数: ${links.length}`);
  console.log(JSON.stringify({ links }, null, 2));

  return links;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────
function setHeaderSub(text) { $("header-sub").textContent = text; }

function setContent(html) {
  $("content").innerHTML = html;

  const fi = $("filter-input");
  if (fi) {
    fi.addEventListener("input", e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll(".link-item").forEach(item => {
        item.style.display = item.dataset.link.toLowerCase().includes(q) ? "" : "none";
      });
    });
  }

  document.querySelectorAll(".copy-one").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.link).then(() => {
        btn.textContent = "✓";
        setTimeout(() => btn.textContent = "⎘", 1200);
      });
    });
  });
}

function showIdle() {
  setHeaderSub("等待 PDF 标签页…");
  setContent(`
    <div class="idle">
      <div class="idle-icon">📄</div>
      请切换到一个 PDF 标签页<br>链接将自动加载
    </div>`);
}

function showLoading(filename) {
  setHeaderSub(filename);
  setContent(`
    <div class="loading">
      <div class="spinner"></div>
      <div class="loading-text">正在解析 PDF…</div>
    </div>`);
}

function showError(filename, msg) {
  setHeaderSub(filename);
  setContent(`<div class="error-box">⚠️ ${msg}</div>`);
}

function showLinks(filename, links) {
  setHeaderSub(filename);

  if (links.length === 0) {
    setContent(`
      <div class="empty">
        <div class="empty-icon">🔍</div>
        已扫描完毕<br>该 PDF 中未找到任何网页链接
      </div>`);
    return;
  }

  const resultJson = JSON.stringify({ filename, links }, null, 2);

  const listItems = links.map(({ link, pageNumber }) => `
    <div class="link-item" data-link="${escHtml(link)}">
      <span class="page-badge">P${pageNumber}</span>
      <a class="link-url" href="${escHtml(link)}" target="_blank">${escHtml(link)}</a>
      <button class="copy-one" data-link="${escHtml(link)}" title="复制">⎘</button>
    </div>`).join("");

  setContent(`
    <div class="summary">
      <div class="summary-count">共找到 <span>${links.length}</span> 个链接</div>
      <button class="btn-copy" id="btn-copy">复制 JSON</button>
    </div>
    <div class="filter-bar">
      <input class="filter-input" id="filter-input" type="text"
             placeholder="过滤链接…" autocomplete="off"/>
    </div>
    <div id="link-list">${listItems}</div>
  `);

  $("btn-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(resultJson).then(() => {
      const b = $("btn-copy");
      b.textContent = "✓ 已复制";
      b.classList.add("copied");
      setTimeout(() => { b.textContent = "复制 JSON"; b.classList.remove("copied"); }, 1800);
    });
  });
}

// ── 标签页切换响应 ────────────────────────────────────────────────────────────
const cache    = new Map(); // url → links[]（同一 PDF 只解析一次）
let currentUrl = null;
let parsing    = false;

async function handleTab(tab) {
  const url = tab?.url;
  if (url === currentUrl) return;   // 同 URL 无需重复处理
  currentUrl = url;

  if (!isPdfUrl(url)) { showIdle(); return; }

  const filename = getFilename(url);

  if (cache.has(url)) { showLinks(filename, cache.get(url)); return; }

  if (parsing) return;   // 已有解析任务进行中
  parsing = true;
  showLoading(filename);

  try {
    const links = await extractLinks(url);
    cache.set(url, links);
    if (currentUrl === url) showLinks(filename, links);
  } catch (err) {
    console.error(err);
    if (currentUrl === url) showError(filename, err.message);
  } finally {
    parsing = false;
  }
}

// ── 监听 background 的标签页变化通知 ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TAB_CHANGED") handleTab(message.tab);
});

// ── 初始化：sidePanel 打开时主动查询当前激活标签页 ───────────────────────────
//
// 注意：sidePanel 实例是绑定到具体 windowId 的，但页面脚本本身不知道自己
// 属于哪个窗口（chrome.windows.getCurrent 在 sidePanel 上下文中也不可靠）。
// 因此改为：向 background 请求"这个 sidePanel 所在窗口的当前激活标签页"，
// background 通过 sender.tab / sender 的窗口信息来确定。
(async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_INIT_TAB" });
    await handleTab(response?.tab);
  } catch (err) {
    console.error(err);
    showIdle();
  }
})();
