"use strict";

/*
 * Injected into the signed-in ChatGPT tab. It types one prepared prompt, presses
 * Send, waits for the answer to finish, and returns the text. It never calls an
 * API and never leaves the page except to hand the answer to the extension.
 */

(() => {
  if (window.__upworkEmailChatGptLoaded) return;
  window.__upworkEmailChatGptLoaded = true;

  const COMPOSER_FINDERS = [
    "#prompt-textarea",
    'form div[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea[data-testid="prompt-textarea"]',
    "form textarea",
  ];
  const SEND_FINDERS = [
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label*="Send" i]',
  ];
  const STOP_FINDERS = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'];
  const ASSISTANT = '[data-message-author-role="assistant"]';
  const USER = '[data-message-author-role="user"]';
  const ACTIVE_KEY = "upworkChatActive";
  const BUDGET_MS = 20 * 60 * 1000;
  const STABLE_MS = 12000;
  const STALL_MS = 4 * 60 * 1000;

  let activeJobId = null;
  const cancelled = new Set();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clean(value) {
    return String(value ?? "")
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function find(finders) {
    for (const finder of finders) {
      try {
        const element = document.querySelector(finder);
        if (element) return element;
      } catch {
        /* skip an unusable selector */
      }
    }
    return null;
  }

  function findEnabled(finders) {
    for (const finder of finders) {
      let list = [];
      try {
        list = Array.from(document.querySelectorAll(finder));
      } catch {
        continue;
      }
      for (const element of list) {
        if (element.hasAttribute("disabled")) continue;
        if (element.getAttribute("aria-disabled") === "true") continue;
        return element;
      }
    }
    return null;
  }

  function composerText(element) {
    if (!element) return "";
    if (element instanceof HTMLTextAreaElement) return element.value || "";
    return element.innerText || element.textContent || "";
  }

  function answerNodes() {
    try {
      return Array.from(document.querySelectorAll(ASSISTANT));
    } catch {
      return [];
    }
  }

  function answerBody(node) {
    return node.querySelector('.markdown, [class*="markdown"]') || node;
  }

  function textOf(node) {
    if (!node) return "";
    const body = answerBody(node);
    const shown = body.innerText || "";
    return clean(shown || body.textContent || "");
  }

  function newestAnswer(beforeCount, beforeLast) {
    const nodes = answerNodes();
    const last = nodes[nodes.length - 1];
    if (!last) return { node: null, text: "" };
    const text = textOf(last);
    const fresh = nodes.length > beforeCount || (text && text !== beforeLast);
    return { node: fresh ? last : null, text: fresh ? text : "" };
  }

  function selectComposer(composer) {
    try {
      composer.focus();
      if (composer instanceof HTMLTextAreaElement) {
        composer.select();
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(composer);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch {
      /* the next approach still has a chance */
    }
  }

  function pasteInto(composer, text) {
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      composer.dispatchEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  function paintInto(composer, text) {
    try {
      if (composer instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(composer, text);
        else composer.value = text;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        composer.textContent = text;
        composer.dispatchEvent(
          new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }),
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  function newChatControl() {
    const finders = [
      'a[data-testid="create-new-chat-button"]',
      'button[data-testid="create-new-chat-button"]',
      'a[aria-label="New chat" i]',
      'button[aria-label="New chat" i]',
      'a[href="/"]',
    ];
    for (const finder of finders) {
      try {
        const elements = Array.from(document.querySelectorAll(finder));
        const control = elements.find((element) => {
          const label = clean(element.getAttribute("aria-label") || element.textContent || "").toLowerCase();
          return element.getAttribute("href") === "/" || label.includes("new chat");
        });
        if (control) return control;
      } catch {
        /* next finder */
      }
    }
    return null;
  }

  async function beginFreshChat() {
    const control = newChatControl();
    if (!control) return;
    if (location.pathname === "/" && answerNodes().length === 0) return;
    try {
      control.click();
    } catch {
      return;
    }
    for (let tries = 0; tries < 24; tries += 1) {
      await sleep(250);
      if (location.pathname === "/" && answerNodes().length === 0 && find(COMPOSER_FINDERS)) return;
    }
  }

  function answerLooksComplete(text) {
    const trimmed = clean(text);
    if (!trimmed) return false;
    if (trimmed.startsWith("```")) return /```$/.test(trimmed);
    if (trimmed.includes("```")) return /```$/.test(trimmed);
    if (trimmed.includes("{")) return trimmed.endsWith("}");
    return true;
  }

  async function typePrompt(prompt) {
    const looksTyped = () => clean(composerText(find(COMPOSER_FINDERS))) === clean(prompt);
    for (const approach of ["insert", "paste", "paint"]) {
      const composer = find(COMPOSER_FINDERS);
      if (!composer) throw new Error("The ChatGPT message box was not found — open chatgpt.com and sign in");
      selectComposer(composer);
      await sleep(120);
      try {
        if (approach === "insert") document.execCommand("insertText", false, prompt);
        else if (approach === "paste") pasteInto(composer, prompt);
        else paintInto(composer, prompt);
      } catch {
        /* the next approach is tried */
      }
      for (let tries = 0; tries < 20; tries += 1) {
        if (looksTyped()) return;
        await sleep(150);
      }
    }
    const got = clean(composerText(find(COMPOSER_FINDERS)));
    throw new Error(`The prompt did not fit in the message box (${got.length}/${prompt.length} characters)`);
  }

  function pressEnter(composer) {
    const options = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent("keydown", options));
    composer.dispatchEvent(new KeyboardEvent("keypress", options));
    composer.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  function userCount() {
    try {
      return document.querySelectorAll(USER).length;
    } catch {
      return 0;
    }
  }

  async function sendPrompt(composer, usersBefore) {
    const taken = () =>
      clean(composerText(find(COMPOSER_FINDERS) || composer)).length === 0 ||
      userCount() > usersBefore ||
      !document.contains(composer);

    for (const approach of ["button", "enter", "form"]) {
      try {
        if (approach === "button") findEnabled(SEND_FINDERS)?.click();
        else if (approach === "enter") pressEnter(composer);
        else {
          const form = composer.closest("form");
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
          else pressEnter(composer);
        }
      } catch {
        /* the next approach is tried */
      }
      for (let tick = 0; tick < 8; tick += 1) {
        await sleep(350);
        if (taken()) return;
      }
      const again = find(COMPOSER_FINDERS);
      if (again) composer = again;
    }
    throw new Error("The prompt was typed but ChatGPT would not send it");
  }

  function stopButton() {
    return find(STOP_FINDERS);
  }

  function copyControl(turn) {
    if (!turn) return null;
    const buttons = Array.from(turn.querySelectorAll('button, [role="button"], [data-testid="copy-turn-action-button"]'));
    const candidates = buttons.filter((button) => {
      if (button.closest("pre")) return false;
      const label = clean(
        button.getAttribute("aria-label") || button.getAttribute("title") || button.getAttribute("data-testid") || "",
      ).toLowerCase();
      return label === "copy" || (label.includes("copy") && !label.includes("code"));
    });
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  function reveal(button) {
    let node = button;
    for (let depth = 0; node && depth < 6; depth += 1) {
      try {
        node.style.setProperty("--actions-opacity", "1");
        node.style.visibility = "visible";
        node.style.contentVisibility = "visible";
      } catch {
        /* next ancestor */
      }
      node = node.parentElement;
    }
    try {
      button.scrollIntoView({ block: "nearest" });
    } catch {
      /* still try the click */
    }
    const host = button.parentElement || button;
    host.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    host.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
  }

  function ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(reply ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function tell(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      /* the worker will be woken by the next message */
    }
  }

  /** Ignore an old clipboard entry when ChatGPT did not actually copy this turn. */
  function sameAnswer(copied, pageText) {
    const normalize = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
    const a = normalize(copied);
    const b = normalize(pageText);
    if (!a || !b) return false;
    if (a === b) return true;
    // Copy returns markdown while the page shows rendered text. Compare the
    // opening of each, which survives **, links and list markers.
    const probe = (value) => value.slice(0, Math.min(120, value.length));
    return a.includes(probe(b)) || b.includes(probe(a));
  }

  async function readAnswer(node, pageText) {
    if (!node) return pageText;
    const turn = node.closest('[data-testid^="conversation-turn"]') || node.closest("article") || node.parentElement;
    const button = copyControl(turn);
    if (button) {
      try {
        reveal(button);
        button.click();
        await sleep(700);
        const reply = await ask({ type: "CHATGPT_CLIPBOARD" });
        const copied = clean(reply?.text || "");
        if (copied && sameAnswer(copied, pageText)) return copied;
      } catch {
        /* the visible text is the fallback */
      }
    }
    return pageText;
  }

  async function waitForReply(jobId, beforeCount, beforeLast) {
    const startedAt = Date.now();
    let lastText = "";
    let lastChange = Date.now();
    let stopSeen = false;
    let stopGoneAt = 0;
    let toldAt = 0;

    while (Date.now() - startedAt < BUDGET_MS) {
      if (cancelled.has(jobId)) throw new Error("Cancelled");
      const current = newestAnswer(beforeCount, beforeLast);
      if (current.text && current.text !== lastText) {
        lastText = current.text;
        lastChange = Date.now();
      }
      const stop = stopButton();
      if (stop) {
        stopSeen = true;
        stopGoneAt = 0;
      } else if (stopSeen && !stopGoneAt) {
        stopGoneAt = Date.now();
      }

      if (lastText && Date.now() - toldAt > 5000) {
        toldAt = Date.now();
        tell({ type: "CHATGPT_PROGRESS", jobId, phase: "waiting", chars: lastText.length });
      }

      if (lastText && !stop) {
        const finished = stopSeen && stopGoneAt && Date.now() - stopGoneAt > 1200;
        const stable = Date.now() - lastChange > STABLE_MS && answerLooksComplete(lastText);
        if (finished || stable) return { node: current.node, text: current.text };
      }

      if (lastText && Date.now() - lastChange > STALL_MS) {
        return { node: current.node, text: lastText };
      }

      if (!lastText && Date.now() - startedAt > 15000 && isBlocked()) {
        throw new Error("ChatGPT is asking for a sign-in or human check — finish it in the ChatGPT tab, then run again");
      }
      await sleep(500);
    }
    throw new Error("ChatGPT did not finish within 20 minutes");
  }


  function isBlocked() {
    try {
      if (document.querySelector('#challenge-form, [data-testid="login-button"], a[href*="/auth/login"]')) return true;
      const text = (document.body?.innerText || "").toLowerCase();
      return text.includes("verify you are human") || text.includes("log in to chatgpt");
    } catch {
      return false;
    }
  }

  async function setActive(job) {
    try {
      await chrome.storage.local.set({ [ACTIVE_KEY]: job });
    } catch {
      /* storage is best effort */
    }
  }

  async function clearActive() {
    try {
      await chrome.storage.local.remove(ACTIVE_KEY);
    } catch {
      /* nothing to clear */
    }
  }

  async function runTask(job, resume) {
    if (activeJobId === job.jobId) return;
    if (activeJobId) return;
    activeJobId = job.jobId;
    try {
      let state = job;
      if (!resume || job.phase !== "waiting") {
        // A fresh chat keeps one lead's text out of the next lead's answer.
        await beginFreshChat();
        const nodes = answerNodes();
        const beforeCount = nodes.length;
        const beforeLast = nodes.length ? textOf(nodes[nodes.length - 1]) : "";
        const usersBefore = userCount();
        const system = clean(job.system || "");
        const prompt = system ? `${system}\n\n---\n\n${job.prompt}` : job.prompt;
        state = { ...job, phase: "typing", beforeCount, beforeLast };
        await setActive(state);
        tell({ type: "CHATGPT_PROGRESS", jobId: job.jobId, phase: "typing" });
        await typePrompt(prompt);
        const composer = find(COMPOSER_FINDERS);
        if (!composer) throw new Error("The ChatGPT message box disappeared before sending");
        await sendPrompt(composer, usersBefore);
        state = { ...state, phase: "waiting" };
        await setActive(state);
        await sleep(900);
      }

      const result = await waitForReply(job.jobId, state.beforeCount ?? 0, state.beforeLast ?? "");
      if (cancelled.has(job.jobId)) throw new Error("Cancelled");
      tell({ type: "CHATGPT_PROGRESS", jobId: job.jobId, phase: "copying", chars: result.text.length });
      const answer = await readAnswer(result.node, result.text);
      if (!clean(answer)) throw new Error("ChatGPT finished but the answer was empty");
      if (cancelled.has(job.jobId)) throw new Error("Cancelled");
      tell({ type: "CHATGPT_REPLY", jobId: job.jobId, text: answer });
      await clearActive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cancelled.has(job.jobId)) {
        tell({ type: "CHATGPT_CANCELLED", jobId: job.jobId });
      } else {
        tell({ type: "CHATGPT_PROBLEM", jobId: job.jobId, message });
      }
      await clearActive();
    } finally {
      activeJobId = null;
      cancelled.delete(job.jobId);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "PING") {
      respond({ ok: true, busy: Boolean(activeJobId) });
      return;
    }
    if (message?.type === "CANCEL") {
      cancelled.add(message.jobId);
      respond({ ok: true });
      return;
    }
    if (message?.type === "RUN_CHATGPT") {
      const job = {
        jobId: message.jobId,
        prompt: message.prompt,
        system: message.system || "",
        createdAt: message.createdAt || Date.now(),
      };
      if (activeJobId === job.jobId) {
        respond({ ok: true, deduped: true });
        return;
      }
      if (activeJobId) {
        respond({ ok: false, busy: true });
        return;
      }
      runTask(job, false);
      respond({ ok: true });
    }
  });

  // A reload/navigation keeps the job in chrome.storage, so the answer can be
  // read from the page instead of typing the prompt a second time.
  try {
    chrome.storage.local.get(ACTIVE_KEY, (stored) => {
      const job = stored?.[ACTIVE_KEY];
      if (job?.jobId && !activeJobId) runTask(job, true);
    });
  } catch {
    /* no stored job */
  }


})();
