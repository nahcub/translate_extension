import { LEVELS } from "./config.js";
import {
  signInWithGoogle,
  isSigningIn,
  signOut,
  refreshSessionIfNeeded,
} from "./auth.js";
import { annotate, define } from "./api.js";

const DEFAULTS = {
  active: false,
  levelIndex: 4, // C1
};

const ERROR_KEY = "pt_last_error";

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(DEFAULTS);
  // Drop legacy demoMode if present
  await chrome.storage.sync.set({
    active: Boolean(cur.active),
    levelIndex: cur.levelIndex ?? DEFAULTS.levelIndex,
  });
  await chrome.storage.sync.remove("demoMode");
  ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
});

function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pt-add-word",
      title: "단어 추가",
      contexts: ["selection"],
    });
  });
}

async function getSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  return {
    active: Boolean(data.active),
    levelIndex: data.levelIndex ?? DEFAULTS.levelIndex,
  };
}

async function setLastError(message) {
  if (!message) {
    await chrome.storage.local.remove(ERROR_KEY);
    return;
  }
  await chrome.storage.local.set({ [ERROR_KEY]: String(message).slice(0, 300) });
}

async function getLastError() {
  const data = await chrome.storage.local.get(ERROR_KEY);
  return data[ERROR_KEY] || null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PT_PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return true;
    } catch (err) {
      console.warn("inject failed", err);
      return false;
    }
  }
}

async function broadcastSettings() {
  const settings = await getSettings();
  const session = await refreshSessionIfNeeded();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) continue;
    if (settings.active && session) {
      await ensureContentScript(tab.id);
    }
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "PT_SETTINGS",
        settings,
        signedIn: Boolean(session),
      });
    } catch {
      // tab without content script
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") broadcastSettings();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(async (err) => {
      await setLastError(err.message);
      sendResponse({
        ok: false,
        error: err.message,
        code: err.code || "ERROR",
      });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "PT_GET_STATE": {
      const settings = await getSettings();
      const session = await refreshSessionIfNeeded();
      return {
        ok: true,
        settings,
        session: session
          ? { email: session.user?.email, id: session.user?.id }
          : null,
        lastError: await getLastError(),
        signingIn: isSigningIn(),
        levels: LEVELS,
      };
    }
    case "PT_CLEAR_ERROR": {
      await setLastError(null);
      return { ok: true };
    }
    case "PT_SET_SETTINGS": {
      const patch = { ...(message.patch || {}) };
      delete patch.demoMode;
      await chrome.storage.sync.set(patch);
      await broadcastSettings();
      return { ok: true };
    }
    case "PT_SIGN_IN": {
      const session = await signInWithGoogle();
      await setLastError(null);
      await broadcastSettings();
      return {
        ok: true,
        session: { email: session.user?.email, id: session.user?.id },
      };
    }
    case "PT_SIGN_OUT": {
      await signOut();
      await broadcastSettings();
      return { ok: true };
    }
    case "PT_ANNOTATE": {
      const settings = await getSettings();
      const level = LEVELS[settings.levelIndex] || "C1";
      const data = await annotate({
        level,
        paragraphs: message.paragraphs,
      });
      await setLastError(null);
      return { ok: true, data };
    }
    case "PT_DEFINE": {
      const settings = await getSettings();
      const level = LEVELS[settings.levelIndex] || "C1";
      const data = await define({
        level,
        text: message.text,
        selection: message.selection,
      });
      await setLastError(null);
      return { ok: true, data };
    }
    default:
      return { ok: false, error: "Unknown message" };
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "pt-add-word" || !tab?.id) return;
  const selection = (info.selectionText || "").trim();
  if (!selection) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "PT_ADD_WORD",
      selection,
    });
  } catch (err) {
    console.warn("PT_ADD_WORD failed", err);
  }
});
