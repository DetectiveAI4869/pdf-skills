// background.js — Service Worker v2.0.0
// 职责：
//   1. 监听标签页激活 / 更新 / 关闭，动态启用/禁用扩展图标
//   2. 点击图标时打开 sidePanel
//   3. 向 sidePanel 通知"当前激活的 PDF 标签页"变化

// ── 工具 ──────────────────────────────────────────────────────────────────────
function isPdfUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith(".pdf")
        || u.href.toLowerCase().includes(".pdf");
  } catch { return false; }
}

// ── 图标状态管理 ──────────────────────────────────────────────────────────────
async function updateIcon(tabId, url) {
  const enabled = isPdfUrl(url);
  try {
    if (enabled) {
      await chrome.action.enable(tabId);
      await chrome.action.setTitle({ tabId, title: "PDF Link Extractor" });
    } else {
      await chrome.action.disable(tabId);
      await chrome.action.setTitle({ tabId, title: "仅支持 PDF 标签页" });
    }
  } catch { /* tab may be gone */ }
}

// ── 点击图标 → 打开 / 切换 sidePanel ─────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!isPdfUrl(tab.url)) return;
  await chrome.sidePanel.open({ windowId: tab.windowId });
  // sidePanel 自己会通过 tabs.query 拿到当前 tab，无需额外消息
});

// ── 标签页激活（切换标签页）──────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateIcon(tabId, tab.url);
    notifySidePanel(tab);
  } catch { /* ignore */ }
});

// ── 标签页 URL 变化（导航 / 刷新）───────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  await updateIcon(tabId, tab.url);
  // 只有当前激活的标签页才通知 sidePanel
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id === tabId) notifySidePanel(tab);
});

// ── 标签页关闭 ────────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active) {
      await updateIcon(active.id, active.url);
      notifySidePanel(active);
    }
  } catch { /* ignore */ }
});

// ── 向所有打开的 sidePanel 发消息 ────────────────────────────────────────────
function notifySidePanel(tab) {
  chrome.runtime.sendMessage({
    type: "TAB_CHANGED",
    tab: { id: tab.id, url: tab.url, title: tab.title }
  }).catch(() => { /* sidePanel 未打开时忽略 */ });
}

// ── 初始化：启动时对所有已有标签设置图标状态 ─────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    await updateIcon(tab.id, tab.url);
  }
});
