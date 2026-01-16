// OpenWork Chrome Extension - Background Service Worker
// Handles side panel opening when clicking the extension icon

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error("Error setting panel behavior:", error);
});

// Listen for installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("OpenWork extension installed successfully");
  } else if (details.reason === "update") {
    console.log("OpenWork extension updated to version", chrome.runtime.getManifest().version);
  }
});

// Handle messages from the side panel
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "HEALTH_CHECK") {
    sendResponse({ status: "ok", version: chrome.runtime.getManifest().version });
  }
  return true;
});
