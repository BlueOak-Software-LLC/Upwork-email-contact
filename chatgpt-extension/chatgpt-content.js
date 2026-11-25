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
    'textarea#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'form div[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    'form textarea',
    '[contenteditable="true"][aria-label*="ChatGPT" i]',
    'div[contenteditable="true"]',
  ];
  const SEND_FINDERS = [
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[data-testid="composer-send-button"]',
    "button#composer-submit-button",
    'button[aria-label="Send prompt" i]',
    'button[aria-label*="Send message" i]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
    '[role="button"][aria-label*="Send" i]',
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

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    // ChatGPT keeps a responsive duplicate of the composer in the DOM. An
    // off-screen copy has a size, so check the viewport too.
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    try {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
    } catch {
      /* keep the rect result */
    }
    return true;
  }

  // ChatGPT renders responsive copies of its controls; the hidden one must not
  // receive the prompt, so only a laid-out element counts.
  function find(finders) {
    for (const finder of finders) {
      let list = [];
      try {
        list = Array.from(document.querySelectorAll(finder));
      } catch {
        continue;
      }
      const element = list.find(visible);
      if (element) return element;
    }
    return null;
  }

  function findEnabled(finders, root = document) {
    for (const finder of finders) {
      let list = [];
      try {
        list = Array.from(root.querySelectorAll(finder));
      } catch {
        continue;
      }
      for (const element of list) {
        if (element.hasAttribute("disabled")) continue;
        if (element.getAttribute("aria-disabled") === "true") continue;
        if (!visible(element)) continue;
        return element;
      }
    }
    return null;
  }

  function composerCandidates() {
    const seen = new Set();
    const found = [];
    for (const finder of COMPOSER_FINDERS) {
      let list = [];
      try {
        list = Array.from(document.querySelectorAll(finder));
      } catch {
        continue;
      }
      for (const element of list) {
        if (seen.has(element) || !visible(element)) continue;
        if (element instanceof HTMLTextAreaElement) {
          if (element.disabled || element.readOnly) continue;
        } else if (!element.isContentEditable) {
          continue;
        }
        seen.add(element);
        found.push(element);
      }
    }
    return found;
  }

  // The main composer is the big editable box near the bottom, usually inside
  // a form or carrying the prompt-textarea id. Scoring avoids the chat-title
  // editor and other contenteditable boxes on the page.
  function composerScore(element) {
    const rect = element.getBoundingClientRect();
    let score = Math.min((rect.width * rect.height) / 1000, 40);
    if (element.id === "prompt-textarea") score += 100;
    if (element.getAttribute("data-testid") === "prompt-textarea") score += 100;
    if (element.closest("form")) score += 40;
    if (element.classList.contains("ProseMirror")) score += 30;
    if (rect.top > innerHeight * 0.35) score += 20;
    return score;
  }

  function findComposer() {
    const found = composerCandidates();
    found.sort((a, b) => composerScore(b) - composerScore(a));
    return found[0] ?? null;
  }

  function sendControl(composer) {
    const scopes = [];
    const form = composer.closest("form");
    if (form) scopes.push(form);
    let node = composer.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1) {
      scopes.push(node);
      node = node.parentElement;
    }
    scopes.push(document);
    for (const scope of scopes) {
      const control = findEnabled(SEND_FINDERS, scope);
      if (control) return control;
    }
    return null;
  }

  // Some pages only react to the full pointer sequence; a bare click() is not
  // enough for them even though it is fine for plain submit buttons.
  function activate(control) {
    if (!control) return;
    const options = { bubbles: true, cancelable: true, view: window, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try {
        const EventType = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
        control.dispatchEvent(new EventType(type, options));
      } catch {
        /* the click below still runs */
      }
    }
    try {
      control.click();
    } catch {
      /* nothing else to try */
    }
  }

  async function waitForComposer(timeoutMs = 25000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const composer = findComposer();
      if (composer) return composer;
      if (isBlocked()) return null;
      await sleep(300);
    }
    return null;
  }

  async function waitForDocumentFocus(timeoutMs = 3000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (document.hasFocus()) return true;
      await sleep(120);
    }
    return document.hasFocus();
  }

  function composerText(element) {
    if (!element) return "";
    if (element instanceof HTMLTextAreaElement) return element.value || "";
    return element.innerText || element.textContent || "";
  }

  function answerNodes() {
    try {
      const roles = Array.from(document.querySelectorAll(ASSISTANT));
      if (roles.length) return roles;
      // Some builds drop the role attributes but keep conversation turns.
      return Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]')).filter(
        (turn) => !turn.querySelector(USER),
      );
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
      if (location.pathname === "/" && answerNodes().length === 0 && findComposer()) return;
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
    const looksTyped = () => clean(composerText(findComposer())) === clean(prompt);
    const ready = await waitForComposer();
    if (!ready) {
      throw new Error(
        "The ChatGPT message box was not found — the tab may still be loading or signed out. Reload chatgpt.com, sign in, then press Run again",
      );
    }
    for (const approach of ["insert", "paste", "paint"]) {
      const composer = findComposer() || ready;
      selectComposer(composer);
      await sleep(120);
      try {
        if (approach === "insert") document.execCommand("insertText", false, prompt);
        else if (approach === "paste") pasteInto(composer, prompt);
        else paintInto(composer, prompt);
      } catch {
        /* the next approach is tried */
      }
      // A raw textContent write can be visible for one frame and then be
      // reverted by the editor; only accept text that survives a beat.
      for (let tries = 0; tries < 24; tries += 1) {
        if (looksTyped()) {
          await sleep(400);
          if (looksTyped()) return;
        }
        await sleep(150);
      }
    }
    const got = clean(composerText(findComposer()));
    throw new Error(
      `The prompt did not fit in the message box (${got.length}/${prompt.length} characters) — click the message box in the ChatGPT tab, then press Run again`,
    );
  }

  function pressEnter(composer) {
    const options = {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    };
    try {
      composer.focus();
    } catch {
      /* dispatch still reaches the listeners */
    }
    for (const type of ["keydown", "keypress", "keyup"]) {
      const event = new KeyboardEvent(type, options);
      // Chrome ignores keyCode in the init dict, while some handlers still
      // read it; define the legacy fields explicitly.
      Object.defineProperty(event, "keyCode", { get: () => 13 });
      Object.defineProperty(event, "which", { get: () => 13 });
      composer.dispatchEvent(event);
    }
  }

  function userCount() {
    try {
      const users = document.querySelectorAll(USER).length;
      if (users) return users;
      return document.querySelectorAll('[data-testid^="conversation-turn"]').length;
    } catch {
      return 0;
    }
  }

  function sendDiagnostics(composer, usersBefore) {
    const controls = [];
    try {
      for (const element of document.querySelectorAll('button, [role="button"]')) {
        if (controls.length >= 6 || !visible(element)) continue;
        const label = clean(
          element.getAttribute("aria-label") || element.getAttribute("data-testid") || element.textContent,
        ).slice(0, 24);
        if (!label || !/send|submit|stop|voice|mic/i.test(label)) continue;
        const off = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
        controls.push(off ? `${label} (disabled)` : label);
      }
    } catch {
      /* diagnostics are best effort */
    }
    const name = composer ? `${composer.tagName.toLowerCase()}${composer.id ? `#${composer.id}` : ""}` : "none";
    const chars = composer ? clean(composerText(composer)).length : 0;
    return `composer=${name} chars=${chars} users=${userCount()}/${usersBefore} controls=[${controls.join(", ")}]`;
  }

  async function waitForUserTurn(usersBefore, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (userCount() > usersBefore) return true;
      await sleep(300);
    }
    return false;
  }

  async function sendPrompt(composer, usersBefore, prompt) {
    // Only a new user turn proves ChatGPT took the prompt; an emptied or
    // rebuilt composer can also mean the page simply re-rendered, so it is
    // only trusted together with a stop button or a chat URL change.
    const startUrl = location.href;
    const marker = clean(prompt).slice(0, 40);
    const attempts = [
      [
        "button",
        () => {
          const control = sendControl(composer);
          if (!control) return false;
          activate(control);
          return true;
        },
      ],
      ["enter", () => (pressEnter(composer), true)],
      [
        "form",
        () => {
          const form = composer.closest("form");
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
          else pressEnter(composer);
          return true;
        },
      ],
    ];

    // A slow or busy ChatGPT can take several seconds to add the optimistic
    // user turn, and a re-render can drop the draft. Retype and retry rather
    // than failing the job on the first quiet send.
    for (let round = 0; round < 3; round += 1) {
      composer = findComposer() || composer;
      if (!clean(composerText(composer)).includes(marker)) {
        await typePrompt(prompt);
        composer = findComposer() || composer;
      }
      for (const [, fire] of attempts) {
        let fired = false;
        try {
          fired = fire() !== false;
        } catch {
          /* the next attempt is tried */
        }
        if (!fired) continue;
        if (await waitForUserTurn(usersBefore, 6000)) return;
        const current = findComposer() || composer;
        if (!clean(composerText(current))) {
          // ChatGPT clears the box as soon as it accepts the message; give a
          // slow thread a moment to paint the user turn before giving up.
          if (await waitForUserTurn(usersBefore, 3500)) return;
          if (stopButton() || location.href !== startUrl) return;
        }
        composer = current;
      }
      await sleep(1200);
    }
    throw new Error(
      `The prompt was typed but ChatGPT would not send it — press Enter in the ChatGPT tab, then press Run again (${sendDiagnostics(composer, usersBefore)})`,
    );
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
        // ChatGPT's Copy action uses the async clipboard API, which needs the
        // document focused; a background tab silently copies nothing.
        await Promise.race([ask({ type: "CHATGPT_FOCUS" }), sleep(1500)]);
        await waitForDocumentFocus(2000);
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

  async function waitForReply(jobId, beforeCount, beforeLast, usersBefore) {
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
      if (!lastText && userCount() <= usersBefore && Date.now() - startedAt > 30000) {
        throw new Error(
          "The prompt never appeared in the ChatGPT tab — stay signed in, wait for the page to load, then press Run again",
        );
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
        // The worker brings the tab forward before this message; wait for the
        // document to actually own focus, because the editor ignores some
        // programmatic input while it is in the background.
        try {
          await Promise.race([ask({ type: "CHATGPT_FOCUS" }), sleep(1500)]);
        } catch {
          /* the tab is already active */
        }
        await waitForDocumentFocus(3000);
        // Persist the job before touching the page: opening "New chat" can
        // replace the document, and the next injection resumes from storage.
        await setActive({ ...job, phase: "opening" });
        // A fresh chat keeps one lead's text out of the next lead's answer.
        await beginFreshChat();
        const nodes = answerNodes();
        const beforeCount = nodes.length;
        const beforeLast = nodes.length ? textOf(nodes[nodes.length - 1]) : "";
        const usersBefore = userCount();
        const system = clean(job.system || "");
        const prompt = system ? `${system}\n\n---\n\n${job.prompt}` : job.prompt;
        state = { ...job, phase: "typing", beforeCount, beforeLast, usersBefore };
        await setActive(state);
        tell({ type: "CHATGPT_PROGRESS", jobId: job.jobId, phase: "typing" });
        await typePrompt(prompt);
        const composer = findComposer();
        if (!composer) throw new Error("The ChatGPT message box disappeared before sending");
        await sendPrompt(composer, usersBefore, prompt);
        state = { ...state, phase: "waiting" };
        await setActive(state);
        await sleep(900);
      }

      const result = await waitForReply(
        job.jobId,
        state.beforeCount ?? 0,
        state.beforeLast ?? "",
        state.usersBefore ?? 0,
      );
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
