# ChatGPT session bridge

This unpacked extension lets the dashboard run its PPD and email prompts in the
ChatGPT tab you are already signed in to. The server never sees your ChatGPT
cookies and never needs an OpenAI API key.

## 1.1.1

- Seeing ChatGPT's Stop control now permanently proves that generation started;
  a missing user-turn/assistant-text selector can no longer produce the false
  "prompt did not start" failure after generation finishes.
- Assistant discovery merges role-marked messages with assistant conversation
  turns, so an older role-marked message cannot hide a newer unmarked answer.
- If generation was observed but the answer takes longer to render, the script
  waits for the latest turn's Copy action and clipboard instead of failing on
  the prompt-start timeout.
- The extension hands the copied response to the dashboard, which posts it to
  `POST /api/chatgpt/jobs/:id/complete`; ChatGPT pages do not call the app API
  directly.

- Before typing, the content script looks for ChatGPT's own **New chat** pill
  (`button.no-drag.rounded-full`, labelled New chat / New conversation /
  Start new chat). It clicks it once at the start and waits up to 20 seconds for
  the fresh chat. The sidebar `data-testid="sidebar-new-chat"` row and buttons
  inside answers are never clicked.
- After the stop button disappears, it checks for that New chat button again.
  If ChatGPT shows one (for example **Start new chat** where the answer should
  be), it clicks it and runs the prompt again in the new chat once. If no New
  chat button is present, it copies the final answer in the current chat.
- The manifest now declares `chatgpt-content.js`, so the Copy implementation
  is loaded on every ChatGPT page instead of relying only on a background
  injection.
- Copy-control detection hovers the answer first, then searches the turn, its
  action group and the document for the real answer Copy button, and rejects
  Copy code/link/table controls.
- Copy is clicked after the stop control disappears; the clipboard is retried,
  validated against the job's JSON shape, and a rendered page JSON fallback is
  used when the clipboard cannot be read.
- Only the ChatGPT tab the worker is managing may resume an active job, so
  other open ChatGPT tabs cannot type the prompt.
- Generate brings the ChatGPT tab to the front and keeps it there through
  generation and Copy, then returns to the dashboard with the result.

## Install

1. Open `chrome://extensions` in Chrome (or Edge/Brave).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `chatgpt-extension` folder.
4. Open the dashboard. The ChatGPT button in the header should turn from
   “extension missing” to “connected”. If it does not, click **Reconnect**.

The manifest carries a fixed `key`, so the extension ID stays
`phieeciapeplplficoclmjenfbmbdcke` across reloads. The dashboard defaults to
that ID; override it with `NEXT_PUBLIC_CHATGPT_EXTENSION_ID` only if you
replace the key and get a different ID.

## How a job runs

1. The dashboard asks the app server for a prompt. The server renders the
   editable template, stores a `chatgpt_jobs` row, and returns it.
2. The manifest declares `chatgpt-content.js` for every ChatGPT page, so the
   Copy code is present as soon as the tab loads. When Generate is clicked, the
   background worker opens or focuses one ChatGPT tab, brings it to the front,
   re-injects the file only if that copy is missing, and sends the prompt.
3. The content script checks for ChatGPT’s **New chat** pill before typing. If
   it is there, it clicks the pill and waits for the fresh chat; otherwise it
   uses the conversation that is open. It then types the prompt and presses
   Send.
4. The ChatGPT tab stays in front while the answer is generated. Once the stop
   button disappears, the content script checks for a New chat button again.
   If one is there, it clicks it and repeats the prompt in the new chat once.
   Otherwise it clicks ChatGPT’s own **Copy** button and reads the clipboard.
   The clipboard is accepted only when it contains the JSON shape this job
   needs (a `ppd` object with sections, or an `email` object with subject and
   content). It must also match the answer on the page, unless the page has no
   readable JSON at all (for example a rendered table or canvas) — then the
   freshly copied JSON is the only usable source. If it is stale, empty or
   unstructured, the script clicks Copy again, up to three times; only then
   does it use structured JSON visible in the page, and it fails with a clear
   message instead of saving plain text.
5. The content script saves the answer under `upworkChatAnswer:<jobId>`, sends
   `CHATGPT_REPLY`, and waits for the worker’s acknowledgement. If the worker
   was asleep, the send is retried; if the page reloads first, the saved answer
   is sent on the next run instead of typing the prompt again.
6. The worker stores the text in its pending-result cache, broadcasts
   `RESULT`, and returns the foreground to the dashboard. The app posts it to
   `POST /api/chatgpt/jobs/:id/complete`; the server parses the JSON, sanitises
   it, and saves the proposal/draft. The browser never writes a draft directly.

## Reliability details

- One job runs at a time; later jobs wait in a persisted queue. The content
  script loads in every ChatGPT tab, but only the tab the worker is managing may
  resume an active job; another tab never types the prompt.
- The current job is kept in `chrome.storage.local`. A tab reload or a service
  worker restart resumes it instead of asking ChatGPT twice.
- Reloading the extension orphans the content script in a tab that is already
  open. The `already loaded` flag is versioned, so the new script can register
  without duplicating a live listener. If the worker still cannot reach the
  page, it reloads the tab once, which gives the declared content script a
  clean start. This is what avoids the raw `Could not establish connection.
  Receiving end does not exist.` error.
- The ChatGPT tab is marked `autoDiscardable: false` and a discarded tab is
  reloaded before use, so a background tab cannot come back blank.
- The content script waits up to 25 seconds for the composer to render. If the
  tab is signed out, still loading, or genuinely empty, the job fails with that
  explanation instead of sitting in **running** forever.
- A send is confirmed by a new user turn, a Stop control, a URL change, or the
  composer clearing after Send. Once Stop has appeared, the job cannot be
  misreported as “prompt did not start”; it waits for the answer/Copy action.
- A two-minute `chrome.alarms` watchdog fails a job whose content script stopped
  answering, so a dead tab does not hang the queue.
- Completed answers stay in `chrome.storage.local` until the dashboard sends
  `ACK`, so reloading the dashboard does not lose an answer.
- The answer is acknowledged by the worker before the cached active job is
  cleared. A duplicate delivery is safe: the dashboard's completion claim makes
  the second write a no-op.
- The dashboard tab is focused again after the answer is stored.
- Cancelling a job stops waiting and tells the ChatGPT tab to ignore the answer.

## Log trail

The drawer shows one timestamped line per step, from both sides of the bridge:

- **Queue / Open** — the job arrived, the ChatGPT tab was located, and the
  content script was injected.
- **Prompt / Input / Sent** — the prompt was typed, the page accepted it, and
  ChatGPT started generating.
- **Wait** — generation started, characters are arriving, and the stop control
  disappeared.
- **Answer / Copy** — the assistant turn was found, the stop control is gone,
  and each Copy click reports whether the clipboard held the expected JSON. A
  retry says which attempt it is; a final fallback says the structured page JSON
  was used.
- **Handoff / Result** — the answer was saved, sent to the worker, stored by the
  dashboard, and acknowledged. A retry names its attempt number.

## Allowed dashboard origins

`externally_connectable` lists localhost, the production
`upwork-email-contact.vercel.app` origin, and the exact preview origin
`upwork-email-contact-coredev367.vercel.app`. Chrome match patterns cannot express a
prefix wildcard such as `upwork-email-contact-*.vercel.app`, so a preview URL
(or any other domain) must be added to `manifest.json` as an **exact** origin
and the extension reloaded. Do not widen it to `https://*.vercel.app/*`: any
Vercel site could then use your signed-in ChatGPT session.

## If a run fails

| What you see | What to do |
| --- | --- |
| **Extension not connected** | Reload `chatgpt-extension/` on `chrome://extensions`, then click **Reconnect** in the drawer. |
| `Could not establish connection. Receiving end does not exist.` | The extension was reloaded while the ChatGPT tab stayed open. Press **Run** again: the worker now re-injects the script (and reloads the tab if needed). |
| The ChatGPT tab has no composer | Finish sign-in or the human check in that tab, wait for the page to finish loading, then press **Run** again. |
| The job says **running** for more than two minutes with no progress | Leave the tab open so the watchdog can inspect it; the job fails with a reason and can be retried. |

## Privacy

The prompt goes to `chatgpt.com` in the browser profile where you are signed
in, exactly as if you pasted it yourself. The extension does not read other
tabs, does not store the answer anywhere except the local pending-result cache,
and does not call any third-party API.
