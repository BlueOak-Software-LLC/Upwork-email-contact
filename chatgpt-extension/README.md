# ChatGPT session bridge

This unpacked extension lets the dashboard run its PPD and email prompts in the
ChatGPT tab you are already signed in to. The server never sees your ChatGPT
cookies and never needs an OpenAI API key.

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
2. The background worker reuses one ChatGPT tab (opens it in the background if
   needed), injects `chatgpt-content.js`, and sends the prompt.
3. The content script types into the composer, clicks Send, waits for the stop
   control to disappear, and reads the answer. It prefers ChatGPT’s own Copy
   button and falls back to the visible answer text.
4. The worker returns the text to the dashboard. The app posts it to
   `POST /api/chatgpt/jobs/:id/complete`; the server parses the JSON, sanitises
   it, and saves the proposal/draft. The browser never writes a draft directly.

## Reliability details

- One job runs at a time; later jobs wait in a persisted queue.
- The current job is kept in `chrome.storage.local`. A tab reload or a service
  worker restart resumes it instead of asking ChatGPT twice.
- Completed answers stay in `chrome.storage.local` until the dashboard sends
  `ACK`, so reloading the dashboard does not lose an answer.
- The dashboard tab is focused again when the answer is copied.
- Cancelling a job stops waiting and tells the ChatGPT tab to ignore the answer.

## Allowed dashboard origins

`externally_connectable` lists localhost and the production
`upwork-email-contact.vercel.app` origin. Chrome match patterns cannot express a
prefix wildcard such as `upwork-email-contact-*.vercel.app`, so a preview URL
(or any other domain) must be added to `manifest.json` as an **exact** origin
and the extension reloaded. Do not widen it to `https://*.vercel.app/*`: any
Vercel site could then use your signed-in ChatGPT session.

## Privacy

The prompt goes to `chatgpt.com` in the browser profile where you are signed
in, exactly as if you pasted it yourself. The extension does not read other
tabs, does not store the answer anywhere except the local pending-result cache,
and does not call any third-party API.
