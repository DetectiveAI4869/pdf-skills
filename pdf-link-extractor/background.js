// background.js — Service Worker v2.0.0
//
// 职责：
//   1. 判断标签页是否为 PDF，动态启用/禁用 sidePanel（per-tab）
//   2. "唤醒"机制：仅当用户曾主动点击图标打开过某个 PDF 标签页的侧边栏后，
//      切换标签页时才会自动重新打开；从未唤醒过的 PDF 标签页只启用入口，
//      不会强制弹出面板（尊重用户选择，避免打扰）。
//   3. 切到非 PDF 标签页 → 禁用面板（Chrome 原生行为：自动隐藏当前面板）。
//   4. 多窗口适配：每个窗口独立维护"当前激活标签页"，windows.onFocusChanged
//      时重新同步图标 + 面板状态，确保跨窗口拖拽标签页后状态依旧正确。
//
// ── Chrome sidePanel API 的已知限制（务必读 README）─────────────────────────
//   · 没有 sidePanel.close()，无法以编程方式强制关闭一个已经打开的面板。
//     "自动关闭"在本实现中等价于：对非 PDF 标签页调用
//     setOptions({ enabled:false })，Chrome 会自动隐藏该标签页对应的面板
//     （这是 Chrome 官方文档描述的标准行为，而不是真正销毁面板窗口）。
//   · sidePanel.open() 必须在“用户手势”的调用栈中触发，否则会抛错
//     "may only be called in response to a user gesture"。
//     因此“自动重新打开”只能在 onActivated / onUpdated 等事件里调用，
//     这些事件本身是用户切换标签页触发的，Chrome 视为有效的用户手势链路。
// ─────────────────────────────────────────────────────────────────────────

const PANEL_PATH = "sidepanel.html";

// 记录"曾被用户主动唤醒过侧边栏"的标签页 ID 集合。
// 只有在这个集合里的 PDF 标签页，切换回去时才会自动重新打开面板。
const awakenedTabs = new Set();

// ── 工具 ──────────────────────────────────────────────────────────────────────
function isPdfUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith(".pdf")
        || u.href.toLowerCase().includes(".pdf");
  } catch { return false; }
}

// ── 同步某个 tab 的图标 + 面板 enabled 状态 ──────────────────────────────────
async function syncTab(tab) {
  if (!tab || tab.id == null || tab.id < 0) return;
  const pdf = isPdfUrl(tab.url);

  try {
    if (pdf) {
      await chrome.action.enable(tab.id);
      await chrome.action.setTitle({ tabId: tab.id, title: "PDF Link Extractor" });
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: PANEL_PATH,
        enabled: true,
      });

      // 曾经被唤醒过 → 自动重新打开（仅在用户切换标签触发的事件回调内调用，
      // 符合 user-gesture 链路要求）
      if (awakenedTabs.has(tab.id)) {
        await chrome.sidePanel.open({ tabId: tab.id });
      }
    } else {
      await chrome.action.disable(tab.id);
      await chrome.action.setTitle({ tabId: tab.id, title: "仅支持 PDF 标签页" });
      // 禁用后 Chrome 会自动隐藏该标签页对应的面板（官方标准行为）
      await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
    }
  } catch {
    // tab 可能已关闭或处于不可访问状态（chrome:// 等），忽略
  }
}

// ── 通知 sidePanel 数据需要刷新（仅通知，不负责开关面板）────────────────────
function notifySidePanel(tab) {
  chrome.runtime.sendMessage({
    type: "TAB_CHANGED",
    tab: { id: tab.id, url: tab.url, title: tab.title },
  }).catch(() => { /* 对应 tab 没有打开的面板时会拒绝，忽略 */ });
}

// ── sidePanel 初始化时主动询问"自己所在窗口当前激活的标签页" ──────────────────
// sidePanel 页面脚本本身不知道自己属于哪个窗口，但 sender.tab 会带有
// 发消息时面板所在窗口的上下文（Chrome 在 sidePanel 场景下会填充该字段）。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_INIT_TAB") {
    (async () => {
      try {
        const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
        const [active] = await chrome.tabs.query({ active: true, windowId });
        sendResponse({ tab: active ?? null });
      } catch {
        // 兜底：查询所有窗口里当前聚焦窗口的激活标签
        try {
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          sendResponse({ tab: active ?? null });
        } catch {
          sendResponse({ tab: null });
        }
      }
    })();
    return true; // 异步响应
  }
});

// ── 点击图标：标记为"已唤醒"，并打开面板 ─────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!isPdfUrl(tab.url)) return; // 非 PDF 标签页图标本应已禁用，双重保险
  awakenedTabs.add(tab.id);
  await chrome.sidePanel.open({ tabId: tab.id });
  notifySidePanel(tab);
});

// ── 标签页激活（切换标签 / 跨窗口移动后聚焦）─────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncTab(tab);
    notifySidePanel(tab);
  } catch { /* tab 可能已不存在 */ }
});

// ── 标签页 URL 变化（导航 / 刷新 / 在同一 tab 内打开新 PDF）──────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;
  await syncTab(tab);

  // 只有当前激活标签页才需要刷新面板内容
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id === tabId) notifySidePanel(tab);
  } catch { /* ignore */ }
});

// ── 标签页关闭：清理"已唤醒"标记，避免内存泄漏 + 误触发 ──────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  awakenedTabs.delete(tabId);
});

// ── 多窗口适配：窗口焦点变化时，重新同步该窗口当前激活标签页 ──────────────────
// 场景：用户把 PDF 标签页从窗口 A 拖到窗口 B，焦点切换到窗口 B 时，
// 需要重新查询窗口 B 当前激活的标签页并同步状态，确保侧边栏跟随正确的窗口。
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // 失去焦点（如切到其他应用）
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active) {
      await syncTab(active);
      notifySidePanel(active);
    }
  } catch { /* ignore */ }
});

// ── 标签页在窗口间移动（拖拽）────────────────────────────────────────────────
// tabs.onMoved 只在同窗口内重新排序时触发；跨窗口拖拽实际上是
// onDetached（旧窗口）+ onAttached（新窗口）的组合。两者都需要重新同步，
// 因为 sidePanel 的 enabled/path 状态是按 tabId 维护的，但其"是否显示"
// 由当前激活窗口决定。
chrome.tabs.onAttached.addListener(async (tabId) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncTab(tab);
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id === tabId) notifySidePanel(tab);
  } catch { /* ignore */ }
});

// ── 初始化：插件安装/更新/浏览器启动时，为所有已存在标签页设置初始状态 ───────
async function initAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    await syncTab(tab);
  }
}

chrome.runtime.onInstalled.addListener(initAllTabs);
chrome.runtime.onStartup.addListener(initAllTabs);
