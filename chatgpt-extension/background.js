"use strict";

/*
 * The bridge between the dashboard and the ChatGPT tab.
 *
 * The app connects through `externally_connectable`; the worker keeps one
 * ChatGPT tab, injects the content script, and stores the answer until the app
 * acknowledges it. Pending results survive a dashboard reload and a service
 * worker restart because they live in chrome.storage.local.
 */

const CHATGPT_URLS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const STORE_KEY = "upworkChatState";
const VERSION = chrome.runtime.getManifest().version;

let state = {
  queue: [],
  current: null,
  results: {},
  chatTabId: null,
  appTabId: null,
};

const ports = new Set();
let loaded = false;
let loading = null;

async function loadState() {
  if (loaded) return state;
  if (loading) return loading;
  loading = chrome.storage.local.get(STORE_KEY).then((stored) => {
    const value = stored?.[STORE_KEY];
    if (value && typeof value === "object") {
      state = {
        queue: Array.isArray(value.queue) ? value.queue : [],
        current: value.current ?? null,
        results: value.results && typeof value.results === "object" ? value.results : {},
        chatTabId: Number.isInteger(value.chatTabId) ? value.chatTabId : null,
        appTabId: Number.isInteger(value.appTabId) ? value.appTabId : null,
      };
    }
    loaded = true;
    loading = null;
    return state;
  });
  return loading;
}

async function saveState() {
  await chrome.storage.local.set({ [STORE_KEY]: state });
}

function broadcast(message) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

function status() {
  return {
    type: "STATUS",
    connected: true,
    version: VERSION,
    chatTabOpen: Boolean(state.chatTabId),
    runningJobId: state.current?.jobId ?? null,
  };
}

async function postStatus(port) {
  try {
    port.postMessage(status());
  } catch {
    ports.delete(port);
  }
}

async function pendingResults() {
  return Object.entries(state.results).map(([jobId, text]) => ({ jobId, text }));
}

async function findChatTab() {
  if (state.chatTabId) {
    try {
      const tab = await chrome.tabs.get(state.chatTabId);
      if (tab && CHATGPT_URLS.some((pattern) => matchUrl(tab.url, pattern))) return tab;
    } catch {
      /* the tab was closed */
    }
    state.chatTabId = null;
  }
  const tabs = await chrome.tabs.query({ url: CHATGPT_URLS });
  const tab = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (tab?.id) {
    state.chatTabId = tab.id;
    return tab;
  }
  return null;
}

function matchUrl(url, pattern) {
  if (!url) return false;
  if (pattern === "https://chatgpt.com/*") return url.startsWith("https://chatgpt.com/");
  if (pattern === "https://chat.openai.com/*") return url.startsWith("https://chat.openai.com/");
  return false;
}

async function waitForTabReady(tabId, timeoutMs = 45_000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("The ChatGPT tab took too long to load"));
    }, timeoutMs);
    function onUpdated(updatedId, info) {
      if (updatedId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function openChatTab() {
  const existing = await findChatTab();
  if (existing?.id) {
    state.chatTabId = existing.id;
    await saveState();
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  if (!tab.id) throw new Error("Chrome did not create the ChatGPT tab");
  state.chatTabId = tab.id;
  await saveState();
  await waitForTabReady(tab.id);
  return tab.id;
}

async function ensureContent(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (pong?.ok) return;
  } catch {
    /* not injected on this navigation yet */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["chatgpt-content.js"] });
  await sleep(350);
  const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
  if (!pong?.ok) throw new Error("The ChatGPT page could not be prepared — reload it and try again");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function focusAppTab() {
  if (!state.appTabId) return;
  try {
    await chrome.tabs.update(state.appTabId, { active: true });
    await chrome.windows.update((await chrome.tabs.get(state.appTabId)).windowId, { focused: true });
  } catch {
    /* the dashboard tab was closed */
  }
}

async function resumeCurrent() {
  await loadState();
  const job = state.current;
  if (!job) return;
  const tab = await findChatTab();
  if (!tab?.id) {
    await failCurrent("The ChatGPT tab was closed before the answer arrived");
    return;
  }
  try {
    await ensureContent(tab.id);
    const reply = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_CHATGPT",
      jobId: job.jobId,
      prompt: job.prompt,
      system: job.system ?? "",
      createdAt: job.createdAt,
    });
    if (reply?.busy) {
      setTimeout(resumeCurrent, 4_000);
    } else if (!reply?.ok) {
      await failCurrent(reply?.error || "The ChatGPT page could not resume the job");
    }
  } catch (error) {
    await failCurrent(error instanceof Error ? error.message : String(error));
  }
}

async function processQueue() {
  await loadState();
  if (state.current) return;
  let job = state.queue.shift();
  if (!job) {
    await saveState();
    return;
  }
  state.current = job;
  await saveState();
  broadcast({ type: "RUNNING", jobId: job.jobId, phase: "opening" });
  try {
    const tabId = await openChatTab();
    await ensureContent(tabId);
    const reply = await chrome.tabs.sendMessage(tabId, {
      type: "RUN_CHATGPT",
      jobId: job.jobId,
      prompt: job.prompt,
      system: job.system ?? "",
      createdAt: job.createdAt,
    });
    if (!reply?.ok) {
      if (reply?.busy) {
        state.queue.unshift(job);
        state.current = null;
        await saveState();
        setTimeout(processQueue, 3_000);
        return;
      }
      throw new Error(reply?.error || "The ChatGPT page refused the prompt");
    }
    broadcast({ type: "RUNNING", jobId: job.jobId, phase: "typing" });
  } catch (error) {
    await failCurrent(error instanceof Error ? error.message : String(error));
  }
}

async function startJob(job, appTabId) {
  await loadState();
  if (appTabId) state.appTabId = appTabId;
  if (state.current?.jobId === job.jobId) return;
  if (state.queue.some((item) => item.jobId === job.jobId)) return;
  // A finished answer that the dashboard has not acknowledged is re-broadcast
  // instead of typing the prompt again.
  if (state.results[job.jobId]) {
    broadcast({ type: "RESULT", jobId: job.jobId, text: state.results[job.jobId] });
    return;
  }
  state.queue.push({
    jobId: job.jobId,
    prompt: job.prompt,
    system: job.system ?? "",
    createdAt: job.createdAt ?? Date.now(),
  });
  await saveState();
  await processQueue();
}

async function cancelJob(jobId) {
  await loadState();
  state.queue = state.queue.filter((job) => job.jobId !== jobId);
  const wasCurrent = state.current?.jobId === jobId;
  if (wasCurrent) {
    if (state.chatTabId) {
      chrome.tabs.sendMessage(state.chatTabId, { type: "CANCEL", jobId }).catch(() => undefined);
    }
    state.current = null;
  }
  await saveState();
  broadcast({ type: "CANCELLED", jobId });
  if (wasCurrent) setTimeout(processQueue, 800);
}

async function failCurrent(message) {
  await loadState();
  const job = state.current;
  if (!job) return;
  state.current = null;
  await saveState();
  broadcast({ type: "ERROR", jobId: job.jobId, message });
  setTimeout(processQueue, 1_000);
}

async function completeCurrent(jobId, text) {
  await loadState();
  if (!state.current || state.current.jobId !== jobId) return;
  state.results[jobId] = text;
  state.current = null;
  await saveState();
  broadcast({ type: "RESULT", jobId, text });
  await focusAppTab();
  setTimeout(processQueue, 800);
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["CLIPBOARD"],
    justification: "Read the answer copied by ChatGPT's own Copy button",
  });
}

async function readClipboard() {
  try {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_READ_CLIPBOARD",
    });
    return typeof reply?.text === "string" ? reply.text : "";
  } catch {
    return "";
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "CHATGPT_CLIPBOARD") {
    readClipboard().then((text) => respond({ text }));
    return true;
  }
  if (message?.type === "CHATGPT_PROGRESS") {
    awaitReady().then(() => {
      if (state.current?.jobId === message.jobId) {
        broadcast({
          type: "RUNNING",
          jobId: message.jobId,
          phase: message.phase,
          chars: message.chars,
        });
      }
    });
    respond({ ok: true });
    return;
  }
  if (message?.type === "CHATGPT_REPLY") {
    completeCurrent(message.jobId, message.text).then(() => respond({ ok: true }));
    return true;
  }
  if (message?.type === "CHATGPT_PROBLEM") {
    failCurrent(message.message || "ChatGPT could not finish").then(() => respond({ ok: true }));
    return true;
  }
  if (message?.type === "CHATGPT_CANCELLED") {
    awaitReady().then(() => {
      broadcast({ type: "CANCELLED", jobId: message.jobId });
    });
    respond({ ok: true });
  }
});

async function awaitReady() {
  await loadState();
}

chrome.runtime.onConnectExternal.addListener((port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  loadState().then(async () => {
    await postStatus(port);
    const results = await pendingResults();
    if (results.length) {
      try {
        port.postMessage({ type: "PENDING_RESULTS", results });
      } catch {
        ports.delete(port);
      }
    }
    if (state.current) {
      // A worker restart can leave a job marked current. Resume it even when
      // more jobs are queued; the content script also keeps its own copy.
      if (!state.chatTabId) {
        await failCurrent("The ChatGPT tab was closed before the answer arrived");
      } else {
        setTimeout(resumeCurrent, 100);
      }
    } else if (state.queue.length) {
      setTimeout(processQueue, 100);
    }
  });

  port.onMessage.addListener((message) => {
    if (message?.type === "RUN") {
      startJob(
        {
          jobId: message.jobId,
          prompt: message.prompt,
          system: message.system,
          createdAt: Date.now(),
        },
        port.sender?.tab?.id,
      ).catch((error) => {
        broadcast({ type: "ERROR", jobId: message.jobId, message: String(error) });
      });
      return;
    }
    if (message?.type === "CANCEL") {
      cancelJob(message.jobId).catch(() => undefined);
      return;
    }
    if (message?.type === "ACK") {
      loadState().then(async () => {
        if (message.jobId in state.results) {
          delete state.results[message.jobId];
          await saveState();
        }
      });
      return;
    }
    if (message?.type === "FOCUS_CHAT") {
      loadState().then(async () => {
        const tab = await findChatTab();
        if (tab?.id) {
          await chrome.tabs.update(tab.id, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      });
    }
  });

  port.onDisconnect.addListener(() => ports.delete(port));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== state.chatTabId) return;
  state.chatTabId = null;
  if (state.current) {
    failCurrent("The ChatGPT tab was closed before the answer arrived");
  } else {
    saveState();
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete" || tabId !== state.chatTabId) return;
  // Re-inject after a reload so an answer that was already written is read.
  ensureContent(tabId).catch(() => undefined);
});

chrome.action.onClicked.addListener(() => {
  loadState().then(async () => {
    const tab = await findChatTab();
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { active: true });
    } else {
      await openChatTab();
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  loadState();
});

loadState();



