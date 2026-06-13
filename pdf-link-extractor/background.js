// background.js - Service Worker for PDF Link Extractor

chrome.action.onClicked.addListener((tab) => {
  // Handled by popup, no action needed here
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_TAB_INFO") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        sendResponse({ tab: tabs[0] });
      } else {
        sendResponse({ error: "No active tab found" });
      }
    });
    return true; // Keep message channel open for async response
  }
});
