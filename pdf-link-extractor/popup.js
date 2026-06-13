// popup.js - PDF Link Extractor popup logic

// ── URL regex ────────────────────────────────────────────────────────────────
const URL_REGEX =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function setContent(html) {
  $("content").innerHTML = html;
}

function setFilename(name) {
  $("header-filename").textContent = name || "未知文件";
}

function isPdfUrl(url) {
  try {
    const u = new URL(url);
    // Chrome's built-in PDF viewer uses chrome-extension or standard http(s) with .pdf
    return (
      u.pathname.toLowerCase().endsWith(".pdf") ||
      u.href.toLowerCase().includes(".pdf")
    );
  } catch {
    return false;
  }
}

function getFilename(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    const raw = parts[parts.length - 1] || u.hostname;
    return decodeURIComponent(raw) || url;
  } catch {
    return url;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url) {
    renderError("无法获取当前标签页信息。");
    return;
  }

  if (!isPdfUrl(tab.url)) {
    renderError(
      "当前页面不是 PDF 文件。<br>请在 Chrome 中打开一个 PDF 文件后再使用此扩展。"
    );
    setFilename("非 PDF 页面");
    return;
  }

  const filename = getFilename(tab.url);
  setFilename(filename);

  // Inject content script to fetch & parse PDF via pdf.js
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractLinksFromPDF,
      args: [
        tab.url,
        chrome.runtime.getURL("lib/pdf.min.js"),
        chrome.runtime.getURL("lib/pdf.worker.min.js"),
      ],
    });

    const result = results?.[0]?.result;

    if (result?.error) {
      renderError(result.error);
      return;
    }

    if (result?.links) {
      renderLinks(filename, result.links);
    } else {
      renderError("未能提取链接，请重试。");
    }
  } catch (err) {
    console.error(err);
    renderError(`执行脚本失败：${err.message}`);
  }
})();

// ── Injected function (runs in page context) ─────────────────────────────────
async function extractLinksFromPDF(pdfUrl, pdfJsUrl, workerUrl) {
  const URL_PATTERN =
    /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

  try {
    // Dynamically load pdf.js into the page
    await new Promise((resolve, reject) => {
      if (window.__pdfJsLoaded__) return resolve();
      const script = document.createElement("script");
      script.src = pdfJsUrl;
      script.onload = () => {
        window.__pdfJsLoaded__ = true;
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load pdf.js"));
      document.head.appendChild(script);
    });

    const pdfjsLib = window.pdfjsLib || window["pdfjs-dist/build/pdf"];

    if (!pdfjsLib) {
      return { error: "pdf.js 加载失败，无法找到 pdfjsLib 对象。" };
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

    // Fetch PDF bytes
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      return { error: `无法获取 PDF 文件 (HTTP ${response.status})` };
    }
    const arrayBuffer = await response.arrayBuffer();

    // Load PDF document
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;

    const links = [];
    const seen = new Set();

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);

      // ── Method 1: Extract from annotation links ──────────────────────────
      const annotations = await page.getAnnotations();
      for (const ann of annotations) {
        if (ann.url) {
          const url = ann.url.trim();
          const key = `${url}::${pageNum}`;
          if (!seen.has(key) && /^https?:\/\//i.test(url)) {
            seen.add(key);
            links.push({ link: url, pageNumber: pageNum });
          }
        }
        // Some PDFs use 'unsafeUrl'
        if (ann.unsafeUrl && !ann.url) {
          const url = ann.unsafeUrl.trim();
          const key = `${url}::${pageNum}`;
          if (!seen.has(key) && /^https?:\/\//i.test(url)) {
            seen.add(key);
            links.push({ link: url, pageNumber: pageNum });
          }
        }
      }

      // ── Method 2: Extract from raw text content ──────────────────────────
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item) => item.str).join(" ");
      const matches = pageText.matchAll(URL_PATTERN);

      for (const match of matches) {
        let url = match[0].replace(/[.,;:!?)]+$/, ""); // strip trailing punctuation
        const key = `${url}::${pageNum}`;
        if (!seen.has(key)) {
          seen.add(key);
          links.push({ link: url, pageNumber: pageNum });
        }
      }
    }

    return { links };
  } catch (err) {
    return { error: `解析 PDF 时出错：${err.message}` };
  }
}

// ── Render functions ──────────────────────────────────────────────────────────
function renderError(msg) {
  setContent(`<div class="error-box">⚠️ ${msg}</div>`);
}

function renderLinks(filename, links) {
  if (links.length === 0) {
    setContent(`
      <div class="empty">
        📄 已扫描完毕<br>
        该 PDF 中未找到任何网页链接。
      </div>
    `);
    return;
  }

  // Build result JSON
  const resultJson = JSON.stringify({ filename, links }, null, 2);

  const summaryHtml = `
    <div class="summary">
      <div class="summary-count">共找到 <span>${links.length}</span> 个链接</div>
      <div class="btn-group">
        <button class="btn btn-copy" id="btn-copy">复制 JSON</button>
        <button class="btn btn-export" id="btn-export">导出 JSON</button>
      </div>
    </div>
    <div class="filter-bar">
      <input class="filter-input" id="filter-input" type="text" placeholder="过滤链接…" autocomplete="off" />
    </div>
  `;

  const listHtml = links
    .map(
      ({ link, pageNumber }, idx) => `
      <div class="link-item" data-link="${escHtml(link)}">
        <span class="page-badge">P${pageNumber}</span>
        <a class="link-url" href="${escHtml(link)}" target="_blank" title="${escHtml(link)}">${escHtml(link)}</a>
        <button class="copy-one" title="复制链接" data-link="${escHtml(link)}">⎘</button>
      </div>`
    )
    .join("");

  const footerHtml = `
    <div class="footer">PDF Link Extractor · 仅提取 http/https 链接</div>
  `;

  setContent(`
    ${summaryHtml}
    <div id="link-list">${listHtml}</div>
    ${footerHtml}
  `);

  // ── Copy JSON button ──
  $("btn-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(resultJson).then(() => {
      const btn = $("btn-copy");
      btn.textContent = "✓ 已复制";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "复制 JSON";
        btn.classList.remove("copied");
      }, 1800);
    });
  });

  // ── Export JSON button ──
  $("btn-export").addEventListener("click", () => {
    const blob = new Blob([resultJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename.replace(/\.pdf$/i, "")}_links.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Per-link copy buttons ──
  document.querySelectorAll(".copy-one").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const link = btn.dataset.link;
      navigator.clipboard.writeText(link).then(() => {
        btn.textContent = "✓";
        setTimeout(() => (btn.textContent = "⎘"), 1200);
      });
    });
  });

  // ── Filter ──
  $("filter-input").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll(".link-item").forEach((item) => {
      item.style.display = item.dataset.link.toLowerCase().includes(q)
        ? ""
        : "none";
    });
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
