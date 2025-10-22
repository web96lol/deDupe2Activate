"use strict";
const wait = timeout => new Promise(resolve => setTimeout(resolve, timeout));

const chromeAPI = {
  getTab: (tabId) => new Promise(resolve => chrome.tabs.get(tabId, resolve)),
  getTabs: (queryInfo = {}) => new Promise(resolve => chrome.tabs.query(queryInfo, resolve)),
  updateTab: (tabId, props) => new Promise(resolve => chrome.tabs.update(tabId, props, resolve)),
  updateWindow: (windowId, props) => new Promise(resolve => chrome.windows.update(windowId, props, resolve)),
  removeTab: (tabId) => new Promise(resolve => chrome.tabs.remove(tabId, resolve)),
  focusTab: async (tabId, windowId) => {
    await Promise.all([
      chromeAPI.updateTab(tabId, { active: true }),
      chromeAPI.updateWindow(windowId, { focused: true })
    ]);
  }
};
const safeTabOperation = async (operation, ...args) => {
  try {
    return await operation(...args);
  } catch (error) {
    if (error.message.includes('No tab with id') || 
        error.message.includes('Tab not found') ||
        error.message.includes('Cannot access')) {
      return null;
    }
    console.error('Tab operation failed:', error);
    throw error;
  }
};
const urlUtils = {
  isBlank: (url) => url === "about:blank",
  isBrowser: (url) => url.startsWith("about:") || url.startsWith("chrome://"),
  isValid: (url) => /^(f|ht)tps?:\/\//i.test(url),
  normalize: (url) => {
    if (!urlUtils.isValid(url)) return url;
    let normalized = url.replace("://www.", "://").toLowerCase();
    return normalized.replace(/\/$/, "");
  },
  toPattern: (url) => {
    if (urlUtils.isValid(url)) {
      const uri = new URL(url);
      let pattern = `*://${uri.hostname}${uri.pathname}`;
      if (uri.search || uri.hash) pattern += "*";
      return pattern;
    } else if (urlUtils.isBrowser(url)) {
      return `${url}*`;
    }
    return null;
  }
};
const storageAPI = {
  get: (keys) => new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(items);
      }
    });
  }),
  set: (items) => new Promise((resolve, reject) => {
    chrome.storage.sync.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  })
};
const sanitizeWhitelist = (entries = []) => {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter((entry) => {
      if (entry.length === 0 || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
};
const normalizeForComparison = (value) => {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
};
const splitHostAndPath = (value) => {
  const [host = "", ...pathParts] = value.split("/");
  const path = pathParts.length ? `/${pathParts.join("/")}` : "";
  return { host, path };
};
const settingsManager = {
  whitelist: [],
  scope: "global",
  async load() {
    try {
      const stored = await storageAPI.get({ whitelist: [], scope: "global" });
      this.whitelist = sanitizeWhitelist(stored.whitelist);
      this.scope = stored.scope === "window" ? "window" : "global";
    } catch (error) {
      console.error("Failed to load whitelist settings:", error);
      this.whitelist = [];
      this.scope = "global";
    }
  },
  isWhitelisted(url) {
    if (!url || !urlUtils.isValid(url) || this.whitelist.length === 0) return false;
    const normalizedUrl = normalizeForComparison(url);
    const urlParts = splitHostAndPath(normalizedUrl);
    return this.whitelist.some((entry) => {
      const normalizedEntry = normalizeForComparison(entry);
      if (!normalizedEntry.length) return false;
      const entryParts = splitHostAndPath(normalizedEntry);
      if (!entryParts.host) return false;

      const hostMatches = urlParts.host === entryParts.host ||
        urlParts.host.endsWith(`.${entryParts.host}`);
      if (!hostMatches) return false;

      if (!entryParts.path) return true;
      return urlParts.path.startsWith(entryParts.path);
    });
  },
  getWindowId(tab) {
    if (!tab) return null;
    if (typeof tab.windowId === "number") return tab.windowId;
    return null;
  },
  isInScope(tab, referenceTab) {
    if (this.scope !== "window") return true;
    const referenceWindowId = this.getWindowId(referenceTab);
    const tabWindowId = this.getWindowId(tab);
    if (referenceWindowId === null || tabWindowId === null) {
      return referenceWindowId === tabWindowId;
    }
    return tabWindowId === referenceWindowId;
  },
  handleStorageChange(changes) {
    if (changes.whitelist) {
      this.whitelist = sanitizeWhitelist(changes.whitelist.newValue || []);
    }
    if (changes.scope) {
      this.scope = changes.scope.newValue === "window" ? "window" : "global";
    }
  }
};
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync") {
    settingsManager.handleStorageChange(changes);
  }
});
class TabsInfo {
  constructor() {
    this.tabs = new Map();
    this.initialize();
  }
  async initialize() {
    const tabs = await safeTabOperation(chromeAPI.getTabs, { status: "complete" });
    if (tabs) {
      tabs.forEach(tab => this.addTab(tab.id, tab.url, tab.windowId));
    }
  }
  addTab(tabId, url = null, windowId = null) {
    this.tabs.set(tabId, { url, windowId, lastUpdate: Date.now(), ignored: false });
  }
  updateTab(tabId, url, windowId = null) {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = { url, windowId, lastUpdate: Date.now(), ignored: false };
      this.tabs.set(tabId, tab);
    } else {
      if (url !== undefined) tab.url = url;
      if (windowId !== null) tab.windowId = windowId;
      tab.lastUpdate = Date.now();
    }
  }

  removeTab(tabId) {
    this.tabs.delete(tabId);
  }

  ignoreTab(tabId, ignored = true) {
    const tab = this.tabs.get(tabId);
    if (tab) tab.ignored = ignored;
  }

  isIgnored(tabId) {
    const tab = this.tabs.get(tabId);
    return !tab || tab.ignored;
  }

  getLastUpdate(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.lastUpdate : null;
  }

  getWindowId(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.windowId : null;
  }
  urlChanged(tabId, newUrl) {
    const tab = this.tabs.get(tabId);
    return !tab || tab.url !== newUrl;
  }
}
const tabsInfo = new TabsInfo();
const duplicateHandler = {
  shouldKeepTab: (tab1, tab2) => {
    const time1 = tabsInfo.getLastUpdate(tab1.id);
    const time2 = tabsInfo.getLastUpdate(tab2.id);
    if (!time1) return tab2;
    if (!time2) return tab1;
    return time1 < time2 ? tab1 : tab2;
  },
  async closeDuplicate(tabToClose, tabToKeep) {
    try {
      tabsInfo.ignoreTab(tabToClose.id);
      await safeTabOperation(chromeAPI.removeTab, tabToClose.id);
      await wait(25);
      
      const windowId = tabsInfo.getWindowId(tabToKeep.id) || tabToKeep.windowId;
      safeTabOperation(chromeAPI.focusTab, tabToKeep.id, windowId).catch(console.error);
    } catch (error) {
      console.error("Failed to close duplicate:", error);
      tabsInfo.ignoreTab(tabToClose.id, false);
    }
  },
  async findAndCloseDuplicates(targetTab) {
    if (tabsInfo.isIgnored(targetTab.id) ||
        urlUtils.isBlank(targetTab.url) ||
        settingsManager.isWhitelisted(targetTab.url)) return;
    
    const pattern = urlUtils.toPattern(targetTab.url);
    if (!pattern) return;
    const queryOptions = {
      url: pattern,
      status: "complete"
    };
    if (settingsManager.scope === "window" && typeof targetTab.windowId === "number") {
      queryOptions.windowId = targetTab.windowId;
    }
    const tabs = await safeTabOperation(chromeAPI.getTabs, queryOptions);
    
    if (!tabs || tabs.length < 2) return;
    
    const normalizedUrl = urlUtils.normalize(targetTab.url);
    
    for (const tab of tabs) {
      if (tab.id === targetTab.id ||
          tabsInfo.isIgnored(tab.id) ||
          !settingsManager.isInScope(tab, targetTab) ||
          settingsManager.isWhitelisted(tab.url)) continue;
      
      if (urlUtils.normalize(tab.url) === normalizedUrl) {
        const tabToKeep = duplicateHandler.shouldKeepTab(targetTab, tab);
        const tabToClose = tabToKeep.id === targetTab.id ? tab : targetTab;
        await duplicateHandler.closeDuplicate(tabToClose, tabToKeep);
        if (tabToClose.id === targetTab.id) break;
      }
    }
  },
  async processAllTabs() {
    try {
      await wait(2000);
      const tabs = await safeTabOperation(chromeAPI.getTabs, { status: "complete" });
      if (tabs) {
        for (const tab of tabs) {
          if (!tabsInfo.isIgnored(tab.id) &&
              !urlUtils.isBlank(tab.url) &&
              !settingsManager.isWhitelisted(tab.url)) {
            await duplicateHandler.findAndCloseDuplicates(tab);
          }
        }
      }
    } catch (error) {
      console.error("Error processing all tabs:", error);
    }
  }
};
const eventHandlers = {
  onTabCreated: (tab) => {
    tabsInfo.addTab(tab.id, tab.url, tab.windowId);
    if (tab.status === "complete" &&
        !urlUtils.isBlank(tab.url) &&
        !settingsManager.isWhitelisted(tab.url)) {
      duplicateHandler.findAndCloseDuplicates(tab).catch(console.error);
    }
  },
  onTabUpdated: (tabId, changeInfo, tab) => {
    if (tabsInfo.isIgnored(tabId) || changeInfo.status !== "complete") return;

    if (tabsInfo.urlChanged(tabId, tab.url)) {
      tabsInfo.updateTab(tabId, tab.url, tab.windowId);
      if (!urlUtils.isBlank(tab.url) && !settingsManager.isWhitelisted(tab.url)) {
        duplicateHandler.findAndCloseDuplicates(tab).catch(console.error);
      }
    }
  },
onTabRemoved: (tabId) => {
  tabsInfo.removeTab(tabId);
},
onTabAttached: (tabId) => {
  (async () => {
    const tab = await safeTabOperation(chromeAPI.getTab, tabId);
    if (tab) {
      tabsInfo.updateTab(tab.id, tab.url, tab.windowId);
      if (!urlUtils.isBlank(tab.url) && !settingsManager.isWhitelisted(tab.url)) {
        await duplicateHandler.findAndCloseDuplicates(tab);
      }
    }
  })();
},
  onBeforeNavigate: (details) => {
    if (details.frameId === 0 &&
        details.tabId !== -1 &&
        !urlUtils.isBlank(details.url) &&
        !settingsManager.isWhitelisted(details.url)) {
      (async () => {
        const tab = await safeTabOperation(chromeAPI.getTab, details.tabId);
        if (tab && !tabsInfo.isIgnored(tab.id)) {
          if (tabsInfo.urlChanged(tab.id, details.url)) {
            tabsInfo.updateTab(tab.id, details.url, tab.windowId);
            if (!settingsManager.isWhitelisted(details.url)) {
              duplicateHandler.findAndCloseDuplicates({ ...tab, url: details.url }).catch(console.error);
            }
          }
        }
      })();
    }
  }
};
const initialize = async () => {
  try {
    console.log("Enhanced Auto DeDupe starting...");

    await settingsManager.load();

    chrome.tabs.onCreated.addListener(eventHandlers.onTabCreated);
    chrome.tabs.onUpdated.addListener(eventHandlers.onTabUpdated);
    chrome.tabs.onRemoved.addListener(eventHandlers.onTabRemoved);
    chrome.tabs.onAttached.addListener(eventHandlers.onTabAttached);
    
    chrome.webNavigation.onBeforeNavigate.addListener(
      eventHandlers.onBeforeNavigate,
      { url: [{ urlMatches: 'https?://.*' }] }
    );
    
    setTimeout(() => duplicateHandler.processAllTabs().catch(console.error), 3000);
    console.log("Enhanced Auto DeDupe initialized successfully");
  } catch (error) {
    console.error("Failed to initialize extension:", error);
  }
};
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "manualCloseDuplicates") {
    duplicateHandler.processAllTabs()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error("Manual duplicate close failed:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});
initialize();
