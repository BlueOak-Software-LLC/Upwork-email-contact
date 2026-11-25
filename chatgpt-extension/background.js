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
const WATCHDOG_ALARM = "upworkChatWatch";
const VERSION = chrome.runtime.getManifest().version;

let state = {
  queue: [],
  current: null,
  results: {},
  chatTabId: null,
  appTabId: null,
};

const ports = new Set();
// Jobs that already handed the foreground back to the dashboard after typing.
const focusReturned = new Set();
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

const PHASE_RANK = { opening: 0, typing: 1, waiting: 2, copying: 3, done: 4 };

function phaseRank(phase) {
  return PHASE_RANK[phase] ?? -1;
}

// Status only moves forward. A late "typing" message must not overwrite a tab
// that is already waiting, and a heartbeat may repeat the current phase.
async function advancePhase(jobId, phase) {
  await loadState();
  if (!state.current || state.current.jobId !== jobId) return false;
  const current = state.current.phase || "opening";
  if (phaseRank(phase) < phaseRank(current)) return false;
  if (phaseRank(phase) === phaseRank(current)) return true;
  state.current.phase = phase;
  await saveState();
  return true;
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

// A step line for the dashboard drawer. Unlike phase updates these are also
// delivered when no job is current (for example the final "answer received"
// line that races the completion), so the trail cannot end mid-step.
function logEvent(jobId, phase, message, extra) {
  if (!jobId) return;
  broadcast({
    type: "LOG",
    jobId,
    entry: { at: Date.now(), phase, message, ...(extra || {}) },
  });
}

function status() {
  return {
    type: "STATUS",
    connected: true,
    version: VERSION,
    chatTabOpen: Boolean(state.chatTabId),
    runningJobId: state.current?.jobId ?? null,
    runningPhase: state.current?.phase ?? null,
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
  // The ChatGPT tab the user is looking at wins over a remembered background
  // one, so "Run" keeps working in the current tab.
  try {
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
      url: CHATGPT_URLS,
    });
    if (active?.id) {
      state.chatTabId = active.id;
      await saveState();
      return active;
    }
  } catch {
    /* fall back to the remembered tab */
  }
  // The ChatGPT tab used most recently wins over the remembered one. The
  // dashboard itself is active when Run is pressed, so preferring a stored id
  // could type into an older background conversation while the user watches a
  // different tab.
  const tabs = await chrome.tabs.query({ url: CHATGPT_URLS });
  const recent = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (recent?.id) {
    state.chatTabId = recent.id;
    await saveState();
    return recent;
  }
  if (state.chatTabId) {
    try {
      const tab = await chrome.tabs.get(state.chatTabId);
      if (tab && CHATGPT_URLS.some((pattern) => matchUrl(tab.url, pattern))) return tab;
    } catch {
      /* the tab was closed */
    }
    state.chatTabId = null;
  }
  return null;
}

function matchUrl(url, pattern) {
  if (!url) return false;
  if (pattern === "https://chatgpt.com/*") return url.startsWith("https://chatgpt.com/");
  if (pattern === "https://chat.openai.com/*") return url.startsWith("https://chat.openai.com/");
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function keepTabAlive(tabId) {
  try {
    // Do not let Chrome discard the ChatGPT tab while a prompt is waiting in
    // the background; a discarded tab comes back blank and loses the bridge.
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* the tab can still be used without this hint */
  }
}

async function ping(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return reply ?? null;
  } catch {
    return null;
  }
}

async function openChatTab() {
  const existing = await findChatTab();
  if (existing?.id) {
    state.chatTabId = existing.id;
    await saveState();
    await keepTabAlive(existing.id);
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  if (!tab.id) throw new Error("Chrome did not create the ChatGPT tab");
  state.chatTabId = tab.id;
  await saveState();
  await keepTabAlive(tab.id);
  await waitForTabReady(tab.id);
  return tab.id;
}

async function ensureChatPage(tabId) {
  let tab = await chrome.tabs.get(tabId);
  if (!CHATGPT_URLS.some((pattern) => matchUrl(tab.url, pattern))) {
    throw new Error(
      "The ChatGPT tab is showing another page. Open chatgpt.com, stay signed in, then press Run again.",
    );
  }
  if (tab.discarded) {
    await chrome.tabs.reload(tabId);
    tab = await chrome.tabs.get(tabId);
  }
  if (tab.status !== "complete") await waitForTabReady(tabId);
  // The composer is rendered by the web app after the document loads.
  await sleep(400);
}

/**
 * A tab that was open when the extension was reloaded keeps a dead copy of the
 * content script and its "already loaded" flag. Clearing the flag lets the
 * fresh script register instead of returning immediately.
 */
async function clearInjectedFlag(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          delete window.__upworkEmailChatGptLoaded;
        } catch {
          window.__upworkEmailChatGptLoaded = false;
        }
      },
    });
  } catch {
    /* the file injection below reports the real failure */
  }
}

async function injectContent(tabId) {
  await clearInjectedFlag(tabId);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["chatgpt-content.js"] });
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(attempt < 4 ? 250 : 500);
    const reply = await ping(tabId);
    if (reply?.ok) return reply;
  }
  return null;
}

async function ensureContent(tabId) {
  const alive = await ping(tabId);
  if (alive?.ok) return alive;
  await ensureChatPage(tabId);
  const injected = await injectContent(tabId);
  if (injected) return injected;
  // A clean reload clears a half-loaded single-page app and a dead context.
  try {
    await chrome.tabs.reload(tabId);
    await waitForTabReady(tabId);
    await sleep(500);
    const retried = await injectContent(tabId);
    if (retried) return retried;
  } catch {
    /* fall through to the clear message below */
  }
  throw new Error(
    "The ChatGPT tab did not load the extension bridge. Reload the ChatGPT tab, stay signed in, then press Run again.",
  );
}

// Focus changes must run one at a time. The dashboard is focused while waiting
// and the ChatGPT tab is focused again for Copy; without a queue a late
// dashboard focus can steal the tab back just before the clipboard write.
let focusChain = Promise.resolve();
// Once Copy starts, keep the ChatGPT window. A late dashboard focus would make
// the clipboard write fail again; only the final result may return to the app.
let pinChatFocus = false;

function withFocusLock(task) {
  const next = focusChain.then(task, task);
  focusChain = next.catch(() => undefined);
  return next;
}

async function focusWindow(windowId) {
  if (!Number.isInteger(windowId)) return;
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (win?.state === "minimized") {
    await chrome.windows.update(windowId, { state: "normal" }).catch(() => undefined);
  }
  await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
}

async function focusAppTab(force = false) {
  if (!state.appTabId) return;
  if (!force && pinChatFocus) return;
  if (!force && state.current?.phase !== "waiting") return;
  await withFocusLock(async () => {
    if (!force && pinChatFocus) return;
    if (!force && state.current?.phase !== "waiting") return;
    try {
      const tab = await chrome.tabs.get(state.appTabId);
      await chrome.tabs.update(state.appTabId, { active: true });
      await focusWindow(tab.windowId);
    } catch {
      /* the dashboard tab was closed */
    }
  });
}

// A background tab can still be typed into, but execCommand and the editor's
// key handling are unreliable without document focus, so the run briefly owns
// the foreground while the prompt is typed and sent. The same activation is
// used again before Copy because ChatGPT writes to the async clipboard.
async function activateChatTab(tabId) {
  return withFocusLock(async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (Number.isInteger(tab.windowId) && Number.isInteger(tab.index)) {
        try {
          await chrome.tabs.highlight({ windowId: tab.windowId, tabs: [tab.index] });
        } catch {
          /* highlighting is a hint; tabs.update already made it active */
        }
      }
      await focusWindow(tab.windowId);
      // Give the OS a moment to hand focus to the window. Poll once or twice
      // because Windows can apply the foreground change asynchronously.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(120);
        const win = await chrome.windows.get(tab.windowId).catch(() => null);
        if (win?.focused) break;
        await focusWindow(tab.windowId);
      }
      return tab;
    } catch {
      /* the tab may have been closed; ensureContent reports that */
      return null;
    }
  });
}

async function resumeCurrent() {
  await loadState();
  const job = state.current;
  if (!job) return;
  logEvent(job.jobId, job.phase || "opening", "Resume: picking the job up after a worker reload");
  const tab = await findChatTab();
  if (!tab?.id) {
    await failCurrent("The ChatGPT tab was closed before the answer arrived");
    return;
  }
  try {
    await ensureContent(tab.id);
    logEvent(job.jobId, job.phase || "opening", "Resume: the ChatGPT bridge is ready");
    await activateChatTab(tab.id);
    const reply = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_CHATGPT",
      jobId: job.jobId,
      prompt: job.prompt,
      system: job.system ?? "",
      createdAt: job.createdAt,
    });
    if (reply?.busy) {
      // The content script is still working on this job. Keep a watchdog armed
      // so a script that dies mid-answer cannot leave the job running forever.
      await armWatchdog(job.jobId);
      setTimeout(resumeCurrent, 4_000);
    } else if (!reply?.ok) {
      await failCurrent(reply?.error || "The ChatGPT page could not resume the job");
    } else {
      await armWatchdog(job.jobId);
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
  pinChatFocus = false;
  state.current = { ...job, phase: "opening" };
  await saveState();
  broadcast({ type: "RUNNING", jobId: job.jobId, phase: "opening" });
  logEvent(job.jobId, "opening", "Queue: job started; locating the ChatGPT tab");
  try {
    const tabId = await openChatTab();
    logEvent(job.jobId, "opening", "Open: ChatGPT tab is ready (tab " + tabId + ")");
    const alive = await ensureContent(tabId);
    logEvent(
      job.jobId,
      "opening",
      alive?.busy
        ? "Bridge: the content script is ready but still busy with the previous answer"
        : "Bridge: content script is ready",
    );
    await activateChatTab(tabId);
    logEvent(job.jobId, "opening", "Prompt: handing the prompt to the ChatGPT page");
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
        pinChatFocus = false;
        await saveState();
        setTimeout(processQueue, 3_000);
        return;
      }
      throw new Error(reply?.error || "The ChatGPT page refused the prompt");
    }
    logEvent(
      job.jobId,
      "typing",
      reply.deduped
        ? "Prompt: the page is already running this job"
        : "Prompt: the page accepted the job; it is typing now",
    );
    await armWatchdog(job.jobId);
    // A deduped reply means this tab is already typing or waiting; do not move
    // the dashboard back to "typing" while the page is waiting for an answer.
    if (!reply.deduped && (await advancePhase(job.jobId, "typing"))) {
      broadcast({ type: "RUNNING", jobId: job.jobId, phase: "typing" });
    }
  } catch (error) {
    await failCurrent(error instanceof Error ? error.message : String(error));
  }
}

async function startJob(job, appTabId) {
  await loadState();
  if (appTabId) state.appTabId = appTabId;
  if (state.current?.jobId === job.jobId) {
    logEvent(job.jobId, state.current.phase || "opening", "Queue: this job is already running");
    return;
  }
  if (state.queue.some((item) => item.jobId === job.jobId)) {
    logEvent(job.jobId, "opening", "Queue: this job is already waiting in the queue");
    return;
  }
  // A finished answer that the dashboard has not acknowledged is re-broadcast
  // instead of typing the prompt again.
  if (state.results[job.jobId]) {
    logEvent(job.jobId, "done", "Queue: replaying the saved answer instead of typing again");
    broadcast({ type: "RESULT", jobId: job.jobId, text: state.results[job.jobId] });
    return;
  }
  logEvent(job.jobId, "opening", "Queue: job received from the dashboard");
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
    await disarmWatchdog();
    if (state.chatTabId) {
      chrome.tabs.sendMessage(state.chatTabId, { type: "CANCEL", jobId }).catch(() => undefined);
    }
    state.current = null;
    pinChatFocus = false;
  }
  await saveState();
  broadcast({ type: "CANCELLED", jobId });
  if (wasCurrent) setTimeout(processQueue, 800);
}

async function armWatchdog(jobId) {
  await loadState();
  if (state.current?.jobId !== jobId) return;
  // Alarms survive a sleeping service worker, unlike setTimeout.
  await chrome.alarms.clear(WATCHDOG_ALARM).catch(() => undefined);
  chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: 2 });
}

async function disarmWatchdog() {
  await chrome.alarms.clear(WATCHDOG_ALARM).catch(() => undefined);
}

async function failCurrent(message) {
  await loadState();
  const job = state.current;
  if (!job) return;
  await disarmWatchdog();
  logEvent(job.jobId, "done", "Stopped: " + message);
  state.current = null;
  pinChatFocus = false;
  await saveState();
  broadcast({ type: "ERROR", jobId: job.jobId, message });
  setTimeout(processQueue, 1_000);
}

async function completeCurrent(jobId, text) {
  await loadState();
  const owns = Boolean(state.current && state.current.jobId === jobId);
  // The answer is stored even if the service worker lost `current` (a restart
  // between the last save and the reply) or the dashboard polled again. The
  // completion endpoint claims the row, so a duplicate delivery is harmless;
  // throwing the answer away here was how a finished ChatGPT turn disappeared.
  if (!owns && state.results[jobId] === text) {
    logEvent(jobId, "done", "Result: the dashboard already has this answer");
    return true;
  }
  logEvent(
    jobId,
    "done",
    "Result: answer received from the ChatGPT tab (" + String(text || "").length + " characters)",
  );
  await disarmWatchdog();
  state.results[jobId] = text;
  if (owns) {
    state.current = null;
    pinChatFocus = false;
  }
  await saveState();
  logEvent(jobId, "done", "Result: answer saved; handing it to the dashboard now");
  broadcast({ type: "RESULT", jobId, text });
  if (owns) {
    await focusAppTab(true);
    setTimeout(processQueue, 800);
  }
  return true;
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  (async () => {
    await loadState();
    const job = state.current;
    if (!job) return;
    const tabId = state.chatTabId;
    if (!tabId) {
      await failCurrent("The ChatGPT tab was closed before the answer arrived");
      return;
    }
    const alive = await ping(tabId);
    // The content script is alive and has its own 20-minute budget. Keep a
    // watchdog armed instead of letting the single alarm expire.
    if (alive?.busy) {
      await armWatchdog(job.jobId);
      return;
    }
    // The script is idle but may have finished the answer and failed every
    // acknowledgement. Recover that saved answer before declaring failure.
    const pending = await chrome.tabs
      .sendMessage(tabId, { type: "CHATGPT_PENDING", jobId: job.jobId })
      .catch(() => null);
    if (
      pending?.jobId === job.jobId &&
      typeof pending.text === "string" &&
      pending.text
    ) {
      logEvent(job.jobId, "done", "Result: recovered the saved answer from the ChatGPT tab");
      await completeCurrent(job.jobId, pending.text);
      return;
    }
    await failCurrent(
      "The ChatGPT tab stopped before the answer was handed back. Reload the tab, stay signed in, then press Run again.",
    );
  })().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "CHATGPT_CLIPBOARD") {
    readClipboard().then((text) => respond({ text }));
    return true;
  }
  if (message?.type === "CHATGPT_FOCUS") {
    awaitReady().then(async () => {
      if (message.reason === "copy" && state.current?.jobId === message.jobId) {
        pinChatFocus = true;
      }
      if (state.chatTabId) await activateChatTab(state.chatTabId);
      respond({ ok: true });
    });
    return true;
  }
  if (message?.type === "CHATGPT_PROGRESS") {
    awaitReady().then(async () => {
      if (state.current?.jobId !== message.jobId) return;
      if (!(await advancePhase(message.jobId, message.phase))) return;
      broadcast({
        type: "RUNNING",
        jobId: message.jobId,
        phase: message.phase,
        chars: message.chars,
      });
      if (message.phase === "waiting" && !focusReturned.has(message.jobId)) {
        focusReturned.add(message.jobId);
        await focusAppTab();
      }
    });
    respond({ ok: true });
    return;
  }
  if (message?.type === "CHATGPT_LOG") {
    awaitReady().then(async () => {
      const entry = message.entry && typeof message.entry === "object" ? message.entry : {};
      if (state.current?.jobId === message.jobId && entry.phase) {
        await advancePhase(message.jobId, entry.phase);
      }
      // Logs are useful even when the job is no longer `current`: the final
      // "answer received" line is sent in the same beat as the reply.
      broadcast({ type: "LOG", jobId: message.jobId, entry });
    });
    respond({ ok: true });
    return true;
  }
  if (message?.type === "CHATGPT_REPLY") {
    completeCurrent(message.jobId, message.text)
      .then((stored) => respond({ ok: true, stored: Boolean(stored) }))
      .catch((error) => respond({ ok: false, error: String(error) }));
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
    // Adopt a ChatGPT tab the person already has open so the drawer and the
    // tab-update listener know about it before the first run.
    const tab = await findChatTab().catch(() => null);
    if (tab?.id) await saveState();
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
        logEvent(message.jobId, "done", "Result: the dashboard stored the answer");
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



