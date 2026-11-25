/* The hidden document that reads the clipboard after the page Copy control runs. */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.target !== "offscreen" || message.type !== "OFFSCREEN_READ_CLIPBOARD") return;
  readClipboard().then(
    (text) => respond({ text }),
    () => respond({ text: "" }),
  );
  return true;
});

async function readClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (typeof text === "string" && text.length) return text;
  } catch {
    /* permission or focus can fail; the textarea command is the fallback */
  }
  try {
    const area = document.createElement("textarea");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const worked = document.execCommand("paste");
    const text = worked ? area.value : "";
    area.remove();
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}
