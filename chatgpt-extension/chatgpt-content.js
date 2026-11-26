"use strict";

/*
 * Injected into the signed-in ChatGPT tab. It types one prepared prompt, presses
 * Send, waits for the answer to finish, and returns the text. It never calls an
 * API and never leaves the page except to hand the answer to the extension.
 */

(() => {
  // Never let a second copy of this file register a second listener. The flag
  // is versioned so a reloaded extension can replace a dead context, while a
  // declarative content script and a programmatic injection still coexist.
  const loadedFlag = "__upworkEmailChatGptLoaded_" + String(chrome.runtime.getManifest().version).replace(/[^a-z0-9]/gi, "_");
  if (window[loadedFlag]) return;
  window[loadedFlag] = true;

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
  const SENT_KEY_PREFIX = "upworkChatSent:";
  const ANSWER_KEY_PREFIX = "upworkChatAnswer:";
  const BUDGET_MS = 20 * 60 * 1000;
  // The stop button disappearing is the primary finish signal; this stable
  // window is the fallback for builds that do not expose one.
  const STABLE_MS = 4000;
  const STALL_MS = 2 * 60 * 1000;

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

  // A control can be laid out outside the current scroll position and still be
  // clickable. This is used for the New chat pill; the composer keeps the
  // stricter viewport check below.
  function rendered(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
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

  // ChatGPT writes the Copy result with the async clipboard API, which is a
  // no-op in a background document. Ask the worker to raise the tab and wait
  // for document focus before clicking; retry because Windows sometimes hands
  // focus over a moment after chrome.windows.update().
  async function focusChat(jobId, reason = "copy") {
    if (document.hasFocus()) return true;
    const label = reason === "new chat" ? "New chat focus" : "Copy focus";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await Promise.race([
          ask({ type: "CHATGPT_FOCUS", jobId, reason }),
          sleep(1200),
        ]);
      } catch {
        /* the worker may be restarting; the tab can still be active */
      }
      try {
        window.focus();
      } catch {
        /* not fatal; the check below decides */
      }
      if (document.hasFocus()) return true;
      if (await waitForDocumentFocus(800)) return true;
      logStep(jobId, "opening", label + ": the tab is still in the background; trying again");
      await sleep(150);
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

  // ---- ChatGPT's own "New chat" controls --------------------------------
  // The flow follows the same button rules as the scraper extension:
  //   <button type="button" class="no-drag ... rounded-full ... min-h-9 px-3
  //     text-sm leading-5 font-medium">New chat</button>
  // The sidebar row (data-testid="sidebar-new-chat", .sidebar-item) is never
  // used, and neither is a button inside an answer. "Start new chat" is the
  // smaller pill ChatGPT shows where an answer should be; it is included.
  const NEW_CHAT_LABEL =
    /^(?:new (?:chat|conversation|thread)|start (?:a |an )?new (?:chat|conversation|thread))$/i;
  const NEW_CHAT_KEY_PREFIX = "upworkChatNewChat:";
  const NEW_CHAT_WAIT_MS = 20000;
  const NEW_CHAT_AGAIN_MS = 5 * 60 * 1000;

  function newChatGuardKey(jobId, again) {
    return NEW_CHAT_KEY_PREFIX + (again ? "again:" : "") + jobId;
  }

  function readNewChatGuard(key) {
    try {
      return Number(sessionStorage.getItem(key) || 0);
    } catch {
      return 0;
    }
  }

  function writeNewChatGuard(key) {
    try {
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      /* the job still works; only the duplicate guard is lost */
    }
  }

  function newChatScore(button) {
    let classes = "";
    try {
      classes = String(button.className || "");
    } catch {
      /* a button without a class string scores zero */
    }
    return (
      (/\bno-drag\b/.test(classes) ? 4 : 0) +
      (/\brounded-full\b/.test(classes) ? 2 : 0) +
      (/\bmin-h-9\b/.test(classes) ? 1 : 0) +
      (/\bpx-3\b/.test(classes) ? 1 : 0)
    );
  }

  function newChatButton() {
    let buttons = [];
    try {
      buttons = Array.from(document.querySelectorAll("button"));
    } catch {
      return null;
    }
    const hits = buttons.filter((button) => {
      if (!button || String(button.tagName || "").toLowerCase() !== "button") return false;
      if (button.hasAttribute("disabled")) return false;
      if (button.getAttribute("aria-disabled") === "true") return false;
      if (!rendered(button)) return false;
      let classes = "";
      try {
        classes = String(button.className || "");
      } catch {
        return false;
      }
      // The sidebar row is also called "New chat"; it must never be clicked.
      if (/\bsidebar-item\b/.test(classes)) return false;
      if (button.getAttribute("data-testid") === "sidebar-new-chat") return false;
      if (button.closest('[data-message-author-role], [data-testid^="conversation-turn"], article, pre')) {
        return false;
      }
      const label = clean(
        button.innerText || button.textContent || button.getAttribute("aria-label") || "",
      );
      if (!NEW_CHAT_LABEL.test(label)) return false;
      // The real header/CTA pill carries both of these classes. A menu entry
      // or a copied template without them is not the ChatGPT button.
      return /\bno-drag\b/.test(classes) && /\brounded-full\b/.test(classes);
    });
    if (!hits.length) return null;
    hits.sort((left, right) => newChatScore(right) - newChatScore(left));
    return hits[0];
  }

  // Click New chat only when ChatGPT actually renders the pill. The initial
  // click and the after-answer click have separate guards, so a reload into
  // either fresh chat does not click again.
  async function startNewChat(jobId, again = false) {
    const guardKey = newChatGuardKey(jobId, again);
    const last = readNewChatGuard(guardKey);
    if (last && Date.now() - last < NEW_CHAT_AGAIN_MS) {
      logStep(
        jobId,
        "opening",
        again
          ? "New chat: this job already followed the second New chat button; keeping the current answer"
          : "New chat: this job already clicked New chat in this tab; using the open chat",
      );
      return false;
    }
    if (stopButton()) {
      logStep(jobId, "opening", "New chat: waiting for the current answer to stop before switching");
      if (!(await waitForStopGone(jobId))) return false;
    }
    const button = newChatButton();
    if (!button) {
      logStep(
        jobId,
        "opening",
        again
          ? "New chat: no New chat button after the answer; copying the answer in this chat"
          : "New chat: no New chat button on this page; using the conversation that is open",
      );
      return false;
    }
    // Mark before clicking: a click that reloads the page must not be repeated
    // by the auto-resume path in the fresh chat.
    writeNewChatGuard(guardKey);
    const buttonLabel = clean(
      button.innerText || button.textContent || button.getAttribute("aria-label") || "New chat",
    );
    logStep(jobId, "opening", 'New chat: found the "' + buttonLabel + '" button; clicking it');
    await focusChat(jobId, "new chat");
    const oldUrl = location.href;
    const oldUsers = userCount();
    const oldAnswers = answerNodes().length;
    try {
      activate(button);
    } catch {
      logStep(jobId, "opening", "New chat: the button could not be clicked; using the conversation that is open");
      return false;
    }
    logStep(jobId, "opening", `New chat: clicked; waiting up to ${NEW_CHAT_WAIT_MS / 1000} seconds for the new chat`);
    const startedAt = Date.now();
    let switched = false;
    while (Date.now() - startedAt < NEW_CHAT_WAIT_MS) {
      if (isBlocked()) break;
      const composer = findComposer();
      const users = userCount();
      const answers = answerNodes().length;
      const urlChanged = location.href !== oldUrl;
      // On an already-empty new-chat page the click changes nothing visible;
      // that page is already the fresh chat this job needs. Give a navigation
      // a beat to start before treating the old empty page as settled.
      const alreadyFresh = oldUsers === 0 && oldAnswers === 0;
      const freshSettled = alreadyFresh && Date.now() - startedAt > 800;
      if (composer && (urlChanged || users < oldUsers || answers < oldAnswers || freshSettled)) {
        switched = true;
        break;
      }
      await sleep(300);
    }
    if (switched) {
      await waitForComposer(8000);
      logStep(jobId, "opening", "New chat: the new chat is open; the prompt will be typed there");
    } else {
      logStep(
        jobId,
        "opening",
        "New chat: the button did not open a new chat in time; using the conversation that is open",
      );
    }
    return switched;
  }

  // The signed-in shell is ready when the composer exists. New chat is checked
  // separately, because some valid conversations do not render that pill.
  async function waitForShell(timeoutMs = 4000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (findComposer()) return true;
      await sleep(200);
    }
    return Boolean(findComposer());
  }

  async function typePrompt(prompt) {
    const canonical = (value) => clean(value).replace(/\s+/g, " ").trim();
    const wanted = canonical(prompt);
    const markerStart = wanted.slice(0, 64);
    // The system prompt is shared by every job, so the opening alone cannot
    // tell one draft from another. The closing characters identify this job.
    const markerEnd = wanted.slice(-64);
    // Editors normalize newlines and trailing spaces, so exact equality is too
    // strict and used to make the same prompt be typed again.
    const looksTyped = () => {
      const value = canonical(composerText(findComposer()));
      if (!value || !markerStart || !markerEnd) return false;
      return value.includes(markerStart) && value.includes(markerEnd);
    };
    const ready = await waitForComposer();
    if (!ready) {
      throw new Error(
        "The ChatGPT message box was not found — the tab may still be loading or signed out. Reload chatgpt.com, sign in, then press Run again",
      );
    }
    // A reload during typing keeps the draft in the editor. Do not type the
    // same prompt over itself; the send step can run from what is already there.
    if (looksTyped()) return;
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
      for (let tries = 0; tries < 16; tries += 1) {
        if (looksTyped()) {
          await sleep(450);
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

  // Typing into a thread that is still writing the previous answer makes the
  // send control disappear and is the usual reason a prompt appears in the box
  // but never runs. The worker sends one job at a time, but a manual question
  // or a slow finish can still leave the tab busy.
  async function waitForIdle(timeoutMs = 90_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!stopButton()) return true;
      await sleep(400);
    }
    return false;
  }

  // A send is proven by any of the page's own signals, not just the optimistic
  // user turn: the stop control appears while an answer is being written, and a
  // new chat address means the request was accepted.
  async function waitForSendSignal(usersBefore, startUrl, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (userCount() > usersBefore) return true;
      if (stopButton() || location.href !== startUrl) return true;
      await sleep(200);
    }
    return false;
  }

  async function sendPrompt(composer, usersBefore) {
    // One pass of the three send affordances. The prompt is never typed again
    // here: a retype after a send that did work is what produced duplicate
    // questions while the tab was still painting the first one.
    const startUrl = location.href;
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

    for (const [, fire] of attempts) {
      let fired = false;
      try {
        fired = fire() !== false;
      } catch {
        /* the next attempt is tried */
      }
      if (!fired) continue;
      if (await waitForSendSignal(usersBefore, startUrl, 6000)) return;
      const current = findComposer() || composer;
      if (!clean(composerText(current))) {
        // An emptied box is the page's own acceptance signal. Give the stop
        // control or user turn a moment to paint, then trust it and wait for
        // the answer; the prompt is never put back, so a slow request cannot
        // become a duplicate.
        for (let tries = 0; tries < 6; tries += 1) {
          if (await waitForSendSignal(usersBefore, startUrl, 300)) return;
          await sleep(150);
        }
        return;
      }
      composer = current;
    }
    throw new Error(
      `The prompt is still in the message box and ChatGPT did not start it — press Enter in the ChatGPT tab, then press Run again (${sendDiagnostics(composer, usersBefore)})`,
    );
  }

  function stopButton() {
    return find(STOP_FINDERS);
  }

  // The answer is only safe to copy after ChatGPT's stop control disappears.
  // waitForReply normally enforces that; this second guard covers a rerender
  // that puts the control back just as the copy step starts.
  async function waitForStopGone(jobId) {
    if (!stopButton()) return true;
    logStep(jobId, "copying", "Copy: the stop button is still visible; waiting before copying");
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await sleep(300);
      if (!stopButton()) {
        await sleep(700);
        if (!stopButton()) {
          logStep(jobId, "copying", "Copy: the stop button disappeared; the answer is finished");
          return true;
        }
      }
    }
    return !stopButton();
  }

  /**
   * ChatGPT moves the Copy control between the message body and the turn's
   * action group depending on the build and the hover state. Search the whole
   * turn and prefer the explicit copy test id/aria label instead of relying on
   * one class or the order of the buttons.
   */
  function isCopyControl(button) {
    if (!button || !button.isConnected) return false;
    if (button.closest("pre, code")) return false;
    const testId = clean(button.getAttribute("data-testid") || "").toLowerCase();
    if (testId === "copy-turn-action-button" || testId === "copy-message-button") return true;
    const label = clean(
      button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent || "",
    ).toLowerCase();
    if (!label) return false;
    if (label.includes("code") || label.includes("markdown") || label.includes("latex")) return false;
    if (label.includes("link") || label.includes("table") || label.includes("image")) return false;
    return (
      label === "copy" ||
      label === "copy response" ||
      label === "copy message" ||
      label === "copy answer" ||
      label === "copy text" ||
      label.includes("copy response") ||
      label.includes("copy message") ||
      label.includes("copy answer") ||
      label.includes("copy text") ||
      label.includes("copy to clipboard") ||
      label.includes("复制")
    );
  }

  function belongsToTurn(button, turn) {
    if (!button || !turn) return true;
    const owner = button.closest(
      'section[data-turn="assistant"], [data-turn="assistant"], [data-testid^="conversation-turn"], article',
    );
    if (!owner) return true; // a portal action row has no turn wrapper
    return owner === turn || turn.contains(owner) || owner.contains(turn);
  }

  function copyControl(turn) {
    if (!turn) return null;
    const scopes = [];
    const add = (scope) => {
      if (scope && !scopes.includes(scope)) scopes.push(scope);
    };
    add(turn);
    // A caller may pass the assistant message itself; the action row normally
    // lives on the enclosing conversation turn.
    add(
      turn.closest(
        'section[data-turn="assistant"], [data-turn="assistant"], [data-testid^="conversation-turn"], article',
      ),
    );
    for (const scope of scopes.slice()) {
      try {
        for (const group of scope.querySelectorAll(
          '[role="group"][aria-label*="action" i], [aria-label*="message actions" i], [aria-label*="response actions" i]',
        )) {
          add(group);
        }
      } catch {
        /* selectors are progressive enhancements */
      }
    }
    const selectors = [
      'button[data-testid="copy-turn-action-button"]',
      'button[data-testid="copy-message-button"]',
      '[data-testid="copy-turn-action-button"]',
      '[data-testid="copy-message-button"]',
      'button[aria-label="Copy" i]',
      'button[aria-label="Copy response" i]',
      'button[aria-label="Copy message" i]',
      'button[aria-label="Copy answer" i]',
      'button[title="Copy" i]',
      '[role="button"][aria-label="Copy" i]',
      '[role="button"][aria-label*="Copy response" i]',
      'button[aria-label*="Copy" i]',
      '[role="button"][aria-label*="Copy" i]',
    ];
    for (const scope of scopes) {
      for (const selector of selectors) {
        let list = [];
        try {
          list = Array.from(scope.querySelectorAll(selector));
        } catch {
          continue;
        }
        for (let index = list.length - 1; index >= 0; index -= 1) {
          if (isCopyControl(list[index])) return list[index];
        }
      }
    }
    // Some builds portal the action row outside the conversation turn. Try
    // the document's copy controls from the end; the clipboard check still
    // rejects a previous turn's answer if the page has newer JSON.
    for (const selector of selectors) {
      let list = [];
      try {
        list = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (isCopyControl(list[index]) && belongsToTurn(list[index], turn)) return list[index];
      }
    }
    // Last resort for a renamed test id: look for a button whose visible
    // tooltip says Copy, while still rejecting Copy code/link controls.
    let buttons = [];
    try {
      buttons = Array.from(turn.querySelectorAll('button, [role="button"]'));
    } catch {
      return null;
    }
    for (let index = buttons.length - 1; index >= 0; index -= 1) {
      if (isCopyControl(buttons[index])) return buttons[index];
    }
    return null;
  }

  function reveal(button) {
    let node = button;
    for (let depth = 0; node && depth < 6; depth += 1) {
      try {
        node.style.setProperty("--actions-opacity", "1");
        node.style.visibility = "visible";
        node.style.contentVisibility = "visible";
        node.style.opacity = "1";
        node.style.pointerEvents = "auto";
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

  // The action row can be mounted only when the answer is hovered. Search the
  // turn first; if the Copy control is not there yet, hover the turn and look
  // again before giving up on the clipboard.
  async function ensureCopyControl(turn) {
    if (!turn) return null;
    let button = copyControl(turn);
    if (button) return button;
    try {
      turn.scrollIntoView({ block: "nearest", inline: "nearest" });
      const options = { bubbles: true, cancelable: true, view: window };
      turn.dispatchEvent(new MouseEvent("mouseover", options));
      turn.dispatchEvent(new MouseEvent("mouseenter", options));
      turn.dispatchEvent(new MouseEvent("mousemove", options));
    } catch {
      /* the selector search below is still worth a try */
    }
    await sleep(600);
    button = copyControl(turn);
    return button;
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

  // The worker can be asleep or restarting exactly when the answer is ready.
  // Wait for its acknowledgement instead of firing and forgetting.
  async function askWithin(message, timeoutMs = 5000) {
    return Promise.race([ask(message), sleep(timeoutMs).then(() => null)]);
  }

  // A readable trail of what the tab is doing. The dashboard shows these lines
  // next to the job, so "waiting" cannot silently look like "typing" again.
  function logStep(jobId, phase, message) {
    tell({
      type: "CHATGPT_LOG",
      jobId,
      entry: { at: Date.now(), phase, message },
    });
  }

  /** The dashboard's server expects one of these two shapes; anything else is a failed copy. */
  function answerMatches(kind, parsed) {
    if (!parsed || typeof parsed !== "object") return false;
    const wantsPpd = kind === "ppd_document" || (!kind && parsed.ppd);
    if (wantsPpd) {
      const ppd = parsed.ppd;
      if (ppd && typeof ppd === "object" && Array.isArray(ppd.sections) && ppd.sections.length) {
        return true;
      }
    }
    const wantsEmail = kind === "email_draft" || kind === "follow_up" || (!kind && parsed.email);
    if (wantsEmail) {
      const email = parsed.email;
      if (
        email &&
        typeof email === "object" &&
        typeof email.subject === "string" &&
        email.subject.trim() &&
        typeof email.content === "string" &&
        email.content.trim()
      ) {
        return true;
      }
    }
    return false;
  }

  /** Read the first complete JSON object with the requested shape. */
  function answerJson(text, accept) {
    const source = clean(text);
    if (!source) return null;
    const candidates = [];
    for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      candidates.push(match[1]);
    }
    candidates.push(source);
    for (const candidate of candidates) {
      const value = candidate.trim();
      for (let start = value.indexOf("{"); start >= 0; start = value.indexOf("{", start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < value.length; i += 1) {
          const ch = value[i];
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') inString = true;
          else if (ch === "{") depth += 1;
          else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
              try {
                const parsed = JSON.parse(value.slice(start, i + 1));
                if (!accept || accept(parsed)) return parsed;
                break;
              } catch {
                break;
              }
            }
          }
        }
      }
    }
    return null;
  }

  function structuredAnswer(kind, text) {
    return answerJson(text, (parsed) => answerMatches(kind, parsed));
  }

  /** Ignore an old clipboard entry when ChatGPT did not actually copy this turn. */
  function sameAnswer(copied, pageText) {
    const normalize = (value) =>
      clean(value)
        .replace(/```[a-z]*\s*/gi, "")
        .replace(/```/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
    const a = normalize(copied);
    const b = normalize(pageText);
    if (!a || !b) return false;
    if (a === b) return true;
    // Copy returns markdown while the page shows rendered text. Compare the
    // opening of each, which survives **, links and list markers.
    const probe = (value) => value.slice(0, Math.min(120, value.length));
    return a.includes(probe(b)) || b.includes(probe(a));
  }

  async function readCopiedClipboard() {
    const reply = await Promise.race([
      ask({ type: "CHATGPT_CLIPBOARD" }),
      sleep(3000).then(() => null),
    ]);
    const fromWorker = clean(reply?.text || "");
    if (fromWorker) return fromWorker;
    // The offscreen document is the reliable path, but a focused ChatGPT tab
    // can also read the clipboard it just wrote. This fallback keeps Copy
    // working if the worker/offscreen context was restarted mid-run.
    try {
      if (navigator.clipboard?.readText) {
        const fromPage = clean(await navigator.clipboard.readText());
        if (fromPage) return fromPage;
      }
    } catch {
      /* focus/permission can reject; the retry loop handles it */
    }
    return "";
  }

  async function readAnswer(jobId, kind, node, pageText) {
    if (!(await waitForStopGone(jobId))) {
      throw new Error("ChatGPT is still writing. Wait for the stop button to disappear, then run again.");
    }
    logStep(jobId, "copying", `Copy: expecting the ${kind || "structured"} JSON shape`);
    const pageAnswer = structuredAnswer(kind, pageText);
    // When the page has no readable JSON, a shape-valid clipboard is accepted;
    // the turn filter above keeps a previous turn's Copy button out of reach.
    const giveUp = () => {
      if (pageAnswer) {
        logStep(jobId, "copying", "Copy: using the structured JSON visible in the page");
        return JSON.stringify(pageAnswer);
      }
      throw new Error(
        "ChatGPT's answer did not contain the expected JSON. Wait for the stop button to disappear, click Copy again, then paste the answer below.",
      );
    };
    if (!node) {
      logStep(jobId, "copying", "Copy: no assistant message node; checking the visible answer");
      return giveUp();
    }
    const turn =
      node.closest(
        'section[data-turn="assistant"], [data-turn="assistant"], [data-testid^="conversation-turn"], article',
      ) || node.parentElement;
    if (!(await ensureCopyControl(turn))) {
      logStep(jobId, "copying", "Copy: no Copy control appeared after hovering the answer; checking the visible answer");
      return giveUp();
    }

    logStep(
      jobId,
      "copying",
      document.hasFocus()
        ? "Copy focus: ChatGPT tab is already focused"
        : "Copy focus: bringing the ChatGPT tab forward",
    );
    const focused = await focusChat(jobId, "copy");
    logStep(
      jobId,
      "copying",
      focused
        ? "Copy focus: ChatGPT tab has focus"
        : "Copy focus: ChatGPT tab did not report focus; trying Copy anyway",
    );

    // ChatGPT occasionally leaves the previous turn on the clipboard. Click
    // Copy again when the clipboard does not hold the JSON shape this job
    // needs, instead of overwriting it with rendered page text.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1 && !document.hasFocus()) {
        logStep(jobId, "copying", `Copy: refocusing the ChatGPT tab before attempt ${attempt}`);
        await focusChat(jobId, "copy");
        await sleep(300);
      }
      const button = await ensureCopyControl(turn);
      if (!button) break;
      try {
        reveal(button);
        try {
          button.focus({ preventScroll: true });
        } catch {
          /* older Chrome ignores the options object */
        }
        logStep(jobId, "copying", `Copy: clicking the Copy button (attempt ${attempt} of 3)`);
        // Use the same trusted-looking pointer sequence as Send. A plain
        // .click() sometimes leaves ChatGPT's hover-only action row inert.
        activate(button);
      } catch {
        logStep(jobId, "copying", `Copy: the Copy action failed (attempt ${attempt} of 3)`);
        await sleep(500);
        continue;
      }

      const deadline = Date.now() + 3000;
      let sawText = false;
      while (Date.now() < deadline) {
        await sleep(300);
        const copied = await readCopiedClipboard();
        if (!copied) continue;
        sawText = true;
        const structured = structuredAnswer(kind, copied);
        if (!structured) continue;
        const samePage = sameAnswer(copied, pageText);
        const sameJson = pageAnswer && JSON.stringify(structured) === JSON.stringify(pageAnswer);
        // The page may render the answer in a canvas/table that has no
        // readable JSON even though ChatGPT's own Copy button has it. In that
        // case the freshly copied, shape-valid JSON is the only usable source.
        if (samePage || sameJson || !pageAnswer) {
          logStep(jobId, "copying", `Copy: the clipboard holds the structured answer (attempt ${attempt})`);
          return copied;
        }
        logStep(jobId, "copying", "Copy: the clipboard has JSON from a different turn; clicking Copy again");
        break;
      }
      logStep(
        jobId,
        "copying",
        sawText
          ? `Copy: the clipboard did not contain the expected JSON (attempt ${attempt} of 3); clicking Copy again`
          : `Copy: the clipboard was empty (attempt ${attempt} of 3); clicking Copy again`,
      );
      await sleep(600);
    }
    logStep(jobId, "copying", "Copy: falling back to the structured JSON visible in the page");
    return giveUp();
  }

  async function waitForReply(jobId, kind, beforeCount, beforeLast, usersBefore) {
    const startedAt = Date.now();
    let lastText = "";
    let lastNode = null;
    let lastChange = Date.now();
    let stopSeen = false;
    let stopGoneAt = 0;
    let toldAt = 0;
    let loggedText = 0;
    let loggedAt = startedAt;

    while (Date.now() - startedAt < BUDGET_MS) {
      if (cancelled.has(jobId)) throw new Error("Cancelled");
      const current = newestAnswer(beforeCount, beforeLast);
      if (current.text && current.text !== lastText) {
        lastText = current.text;
        if (current.node) lastNode = current.node;
        lastChange = Date.now();
      }
      const stop = stopButton();
      if (stop) {
        if (!stopSeen) logStep(jobId, "waiting", "Wait: ChatGPT is generating the answer");
        stopSeen = true;
        stopGoneAt = 0;
      } else if (stopSeen && !stopGoneAt) {
        stopGoneAt = Date.now();
        logStep(jobId, "copying", "Wait: ChatGPT stopped generating; finishing the answer");
      }

      // A heartbeat is sent even before any assistant text is visible. Without
      // it the dashboard kept the last "typing" message while ChatGPT was
      // already generating the answer.
      if (Date.now() - toldAt > 5000) {
        toldAt = Date.now();
        tell({ type: "CHATGPT_PROGRESS", jobId, phase: "waiting", chars: lastText.length });
      }
      if (lastText && (loggedText === 0 || Date.now() - loggedAt > 10000)) {
        logStep(
          jobId,
          "waiting",
          loggedText === 0
            ? `Wait: answer started (${lastText.length} characters)`
            : `Wait: answer is growing (${lastText.length} characters)`,
        );
        loggedText = lastText.length;
        loggedAt = Date.now();
      }

      if (lastText && !stop) {
        const finished = stopSeen && stopGoneAt && Date.now() - stopGoneAt > 1200;
        // Never call a short pause "finished" while the stop control is still
        // on screen: a long JSON answer pauses between fields, and treating
        // that as done truncated the PPD. Stable is only a fallback for builds
        // that do not render a stop control at all.
        // If the stop control was never rendered (fast answer or an older
        // build), a structured answer can settle quickly. A rendered answer
        // that has no readable JSON (for example a canvas/table) still needs a
        // longer quiet window so a long JSON body is not cut mid-field.
        const structured = Boolean(structuredAnswer(kind, lastText));
        const stableWindow = structured ? STABLE_MS : stopSeen ? STABLE_MS : 8000;
        const stable = Date.now() - lastChange > stableWindow;
        if (finished || stable) {
          logStep(jobId, "copying", `Answer finished (${lastText.length} characters)`);
          return { node: lastNode, text: lastText };
        }
      }

      if (lastText && !stop && Date.now() - lastChange > STALL_MS) {
        logStep(jobId, "copying", `Answer stopped changing (${lastText.length} characters)`);
        return { node: lastNode, text: lastText };
      }

      if (!lastText && Date.now() - startedAt > 15000 && isBlocked()) {
        throw new Error("ChatGPT is asking for a sign-in or human check — finish it in the ChatGPT tab, then run again");
      }
      // While the stop control is visible ChatGPT is generating, even when its
      // assistant markup is not readable yet. Do not fail that as "not sent".
      if (
        !lastText &&
        !stop &&
        userCount() <= usersBefore &&
        Date.now() - startedAt > 30000
      ) {
        throw new Error(
          "The prompt did not start in the ChatGPT tab — press Enter there, then press Run again. If ChatGPT is already answering, wait for it to finish.",
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

  async function clearActive(jobId) {
    try {
      const stored = await chrome.storage.local.get(ACTIVE_KEY);
      const active = stored?.[ACTIVE_KEY];
      // Never let a late handoff for job A clear the active marker for job B.
      if (!active || !jobId || active.jobId === jobId) {
        await chrome.storage.local.remove(ACTIVE_KEY);
      }
      if (jobId) await chrome.storage.local.remove(SENT_KEY_PREFIX + jobId);
    } catch {
      /* nothing to clear */
    }
  }

  // Written as soon as ChatGPT accepts a prompt. A reload then waits for the
  // answer instead of typing the same prompt into the conversation again.
  async function readSent(jobId) {
    try {
      const key = SENT_KEY_PREFIX + jobId;
      const stored = await chrome.storage.local.get(key);
      return stored?.[key] || null;
    } catch {
      return null;
    }
  }

  async function writeSent(jobId, data) {
    try {
      await chrome.storage.local.set({ [SENT_KEY_PREFIX + jobId]: data });
    } catch {
      /* storage is best effort */
    }
  }

  async function clearSent(jobId) {
    try {
      await chrome.storage.local.remove(SENT_KEY_PREFIX + jobId);
    } catch {
      /* nothing to clear */
    }
  }

  // A finished answer is persisted before the handoff. If the worker misses the
  // message (or the page reloads at that moment), the next RUN/resume sends the
  // saved answer instead of typing the whole prompt again.
  async function readPendingReply(jobId) {
    try {
      const key = ANSWER_KEY_PREFIX + jobId;
      const stored = await chrome.storage.local.get(key);
      const value = stored?.[key];
      return value && typeof value.text === "string" && value.text ? value : null;
    } catch {
      return null;
    }
  }

  async function writePendingReply(jobId, text) {
    try {
      await chrome.storage.local.set({
        [ANSWER_KEY_PREFIX + jobId]: { text, at: Date.now() },
      });
    } catch {
      /* storage is best effort; the retry below still runs */
    }
  }

  async function clearPendingReply(jobId) {
    try {
      await chrome.storage.local.remove(ANSWER_KEY_PREFIX + jobId);
    } catch {
      /* nothing to clear */
    }
  }

  async function sendReplyToApp(jobId, text) {
    await writePendingReply(jobId, text);
    logStep(jobId, "copying", "Handoff: sending the answer to the extension worker");
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const reply = await askWithin({ type: "CHATGPT_REPLY", jobId, text }, 5000);
      if (reply?.ok) {
        await clearPendingReply(jobId);
        logStep(
          jobId,
          "done",
          attempt === 1
            ? "Handoff: the worker stored the answer"
            : "Handoff: the worker stored the answer after " + attempt + " tries",
        );
        return true;
      }
      logStep(
        jobId,
        "copying",
        "Handoff: the worker did not acknowledge (try " + attempt + "/12); retrying",
      );
      await sleep(800);
    }
    logStep(
      jobId,
      "copying",
      "Handoff: the worker never acknowledged; the answer is saved and will be sent when the dashboard runs this job again",
    );
    return false;
  }

  async function runTask(job, resume) {
    if (activeJobId === job.jobId) return;
    if (activeJobId) return;
    activeJobId = job.jobId;
    try {
      const pending = await readPendingReply(job.jobId);
      if (pending) {
        logStep(job.jobId, "copying", "Resume: found the finished answer; sending it before typing");
        const stored = await sendReplyToApp(job.jobId, pending.text);
        if (stored) await clearActive(job.jobId);
        return;
      }
      let state = job;
      let needsSend = !(resume && job.phase === "waiting");
      logStep(
        job.jobId,
        "opening",
        "Opening: checking the ChatGPT tab (" + location.host + location.pathname + ")",
      );
      if (resume && job.phase !== "waiting") {
        const sent = await readSent(job.jobId);
        if (sent && Number.isFinite(sent.beforeCount)) {
          state = { ...job, ...sent, phase: "waiting" };
          needsSend = false;
          await setActive(state);
          tell({ type: "CHATGPT_PROGRESS", jobId: job.jobId, phase: "waiting" });
          logStep(job.jobId, "waiting", "Prompt was already sent; waiting for the answer");
        }
      } else if (resume && job.phase === "waiting") {
        logStep(job.jobId, "waiting", "Resume: this prompt was already sent; waiting for the answer");
      }
      const system = clean(job.system || "");
      const prompt = system ? system + "\n\n---\n\n" + job.prompt : job.prompt;
      let retriedNewChat = false;
      let freshChat = false;

      while (true) {
        if (needsSend) {
          // The worker brings the tab forward before this message; wait for the
          // document to actually own focus, because the editor ignores some
          // programmatic input while it is in the background.
          try {
            await Promise.race([ask({ type: "CHATGPT_FOCUS" }), sleep(1500)]);
          } catch {
            /* the tab is already active */
          }
          await waitForDocumentFocus(3000);
          if (!(await waitForIdle())) {
            throw new Error(
              "ChatGPT is still writing the previous answer — wait for it to finish in the ChatGPT tab, then press Run again",
            );
          }
          // Persist the job before touching the page so a reload can resume it.
          await setActive({ ...job, phase: "opening" });
          await waitForShell();

          let opened = false;
          if (freshChat) {
            opened = true;
            freshChat = false;
            logStep(job.jobId, "opening", "New chat: the automatic New chat is open; typing there");
          } else {
            opened = await startNewChat(job.jobId, false);
          }
          if (opened) await waitForShell();
          logStep(
            job.jobId,
            "opening",
            opened
              ? "Ready: using the fresh ChatGPT conversation"
              : "Ready: using the open ChatGPT conversation",
          );

          const nodes = answerNodes();
          const beforeCount = nodes.length;
          const beforeLast = nodes.length ? textOf(nodes[nodes.length - 1]) : "";
          const usersBefore = userCount();
          state = { ...job, phase: "typing", beforeCount, beforeLast, usersBefore };
          await setActive(state);
          // A second New chat restarts the prompt after the first "waiting"
          // phase. Do not send a lower phase that the worker/dashboard would
          // ignore; the next "waiting" heartbeat is valid again.
          if (!retriedNewChat) {
            tell({ type: "CHATGPT_PROGRESS", jobId: job.jobId, phase: "typing" });
          }
          logStep(job.jobId, "typing", "Input: typing the prompt (" + prompt.length + " characters)");
          await typePrompt(prompt);
          logStep(job.jobId, "typing", "Start: prompt is in the message box; sending it");
          const composer = findComposer();
          if (!composer) throw new Error("The ChatGPT message box disappeared before sending");
          await sendPrompt(composer, usersBefore);
          await writeSent(job.jobId, {
            beforeCount: state.beforeCount,
            beforeLast: state.beforeLast,
            usersBefore: state.usersBefore,
            at: Date.now(),
          });
          state = { ...state, phase: "waiting" };
          await setActive(state);
          // Send this before waiting for the first token; this is the status the
          // person needs to see while ChatGPT is generating.
          tell({ type: "CHATGPT_PROGRESS", jobId: job.jobId, phase: "waiting", chars: 0 });
          logStep(job.jobId, "waiting", "Sent: ChatGPT accepted the prompt; waiting for the answer");
          await sleep(900);
          needsSend = false;
        }

        const result = await waitForReply(
          job.jobId,
          job.kind,
          state.beforeCount ?? 0,
          state.beforeLast ?? "",
          state.usersBefore ?? 0,
        );
        if (cancelled.has(job.jobId)) throw new Error("Cancelled");

        // Step 3: only once the stop button is gone, look for a New chat
        // button again. "Start new chat" means this chat is not the place to
        // take an answer from, so click it and run the prompt again there.
        await waitForStopGone(job.jobId);
        if (!retriedNewChat && !stopButton()) {
          const nextChat = newChatButton();
          if (!nextChat) {
            logStep(job.jobId, "copying", "New chat: no New chat button after the answer; copying this answer");
          } else {
            retriedNewChat = true;
            logStep(
              job.jobId,
              "copying",
              'New chat: found the "' + clean(nextChat.innerText || nextChat.textContent) + '" button after the answer; running the prompt again there',
            );
            // The old prompt's "sent" marker must not make the fresh chat look
            // like it is already waiting for an answer.
            await clearSent(job.jobId);
            await setActive({ ...job, phase: "opening" });
            const switched = await startNewChat(job.jobId, true);
            if (switched) {
              freshChat = true;
              needsSend = true;
              state = { ...job, phase: "typing" };
              await setActive(state);
              logStep(job.jobId, "typing", "New chat: starting the prompt again in the new chat");
              continue;
            }
            if (result.node && !result.node.isConnected) {
              throw new Error(
                "Clicking New chat after the answer cleared the chat, but the new chat did not finish opening. Wait for ChatGPT, then press Run again.",
              );
            }
            logStep(job.jobId, "copying", "New chat: could not switch; copying the answer in this chat");
          }
        }

        logStep(
          job.jobId,
          "copying",
          "Answer: captured " + result.text.length + " characters from the page",
        );
        tell({ type: "CHATGPT_PROGRESS", jobId: job.jobId, phase: "copying", chars: result.text.length });
        const answer = await readAnswer(job.jobId, job.kind, result.node, result.text);
        if (!clean(answer)) throw new Error("ChatGPT finished but the answer was empty");
        if (cancelled.has(job.jobId)) throw new Error("Cancelled");
        logStep(job.jobId, "copying", "Answer: ready to hand over (" + answer.length + " characters)");
        // Do not report "done" yet: the answer is only done once the worker has
        // stored it and the dashboard has claimed it. The worker emits the done
        // phase from completeCurrent after the handoff.
        tell({ type: "CHATGPT_PROGRESS", jobId: job.jobId, phase: "copying", chars: answer.length });
        const stored = await sendReplyToApp(job.jobId, answer);
        if (stored) await clearActive(job.jobId);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStep(job.jobId, "done", cancelled.has(job.jobId) ? "Stopped by the dashboard" : "Stopped: " + message);
      if (cancelled.has(job.jobId)) {
        tell({ type: "CHATGPT_CANCELLED", jobId: job.jobId });
        await clearPendingReply(job.jobId);
      } else {
        tell({ type: "CHATGPT_PROBLEM", jobId: job.jobId, message });
      }
      await clearActive(job.jobId);
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
    if (message?.type === "CHATGPT_PENDING") {
      void (async () => {
        try {
          const stored = await chrome.storage.local.get(ACTIVE_KEY);
          const job = stored?.[ACTIVE_KEY];
          // The worker names the job, so a pending answer is recoverable even
          // if the active marker was cleared by a late error.
          const jobId = message.jobId || job?.jobId;
          const pending = jobId ? await readPendingReply(jobId) : null;
          respond(pending && jobId ? { jobId, text: pending.text } : {});
        } catch {
          respond({});
        }
      })();
      return true;
    }
    if (message?.type === "RUN_CHATGPT") {
      const job = {
        jobId: message.jobId,
        kind: message.kind || "",
        prompt: message.prompt,
        system: message.system || "",
        createdAt: message.createdAt || Date.now(),
      };
      if (activeJobId === job.jobId) {
        respond({ ok: true, deduped: true });
        return;
      }
      if (activeJobId) {
        respond({ ok: false, busy: true, jobId: activeJobId });
        return;
      }
      runTask(job, false);
      respond({ ok: true });
    }
  });

  // A reload/navigation keeps the job in chrome.storage, so the answer can be
  // read from the page instead of typing the prompt a second time. Only the
  // tab the worker is managing may resume: this file also loads in every other
  // ChatGPT tab, and those tabs must not type the active prompt by themselves.
  void (async () => {
    try {
      const role = await Promise.race([
        ask({ type: "CHATGPT_ROLE" }),
        sleep(3000).then(() => null),
      ]);
      if (!role?.managed || !role.jobId || activeJobId) return;
      const stored = await chrome.storage.local.get(ACTIVE_KEY);
      const job = stored?.[ACTIVE_KEY];
      if (job?.jobId === role.jobId && !activeJobId) runTask(job, true);
    } catch {
      /* no stored job or the worker is starting */
    }
  })();

})();
