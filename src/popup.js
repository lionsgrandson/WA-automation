document.addEventListener("DOMContentLoaded", async () => {
  const enabled = document.getElementById("enabled");
  const autoSend = document.getElementById("autoSend");
  const summary = document.getElementById("summary");
  const status = document.getElementById("status");

  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!response?.ok) {
    summary.textContent = "Could not load settings.";
    return;
  }

  const settings = response.settings;
  enabled.checked = Boolean(settings.enabled);
  autoSend.checked = Boolean(settings.autoSend);
  summary.textContent = settings.businessName
    ? `${settings.businessName} · ${settings.model}`
    : `Not configured · ${settings.model}`;

  async function saveToggle() {
    const result = await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      settings: {
        enabled: enabled.checked,
        autoSend: autoSend.checked
      }
    });
    status.textContent = result?.ok ? "Saved." : result?.error || "Save failed.";
  }

  enabled.addEventListener("change", saveToggle);
  autoSend.addEventListener("change", saveToggle);

  document.getElementById("diagnose").addEventListener("click", async () => {
    status.textContent = "Diagnosing current chat…";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !String(tab.url || "").startsWith("https://web.whatsapp.com/")) {
      status.textContent = "Open WhatsApp Web and a chat first.";
      return;
    }

    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "WA_DIAGNOSE_CHAT" });
      const d = result?.diagnostic;

      if (!result?.ok || !d) {
        status.textContent = result?.error || "Diagnosis failed.";
        return;
      }

      status.textContent =
        `${d.total} messages: ${d.incoming} incoming / ${d.outgoing} outgoing / ${d.unknown} unknown. Latest: ${d.latestDirection} — ${d.latestText || "(no text)"}`;
    } catch (error) {
      status.textContent = "Could not reach WhatsApp. Refresh WhatsApp Web and try again.";
    }
  });

  document.getElementById("testWriter").addEventListener("click", async () => {
    status.textContent = "Testing WhatsApp composer…";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !String(tab.url || "").startsWith("https://web.whatsapp.com/")) {
      status.textContent = "Open WhatsApp Web and a chat first.";
      return;
    }

    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: "WA_TEST_WRITE",
        text: "בדיקת WA Automation — אפשר למחוק את ההודעה הזאת."
      });

      status.textContent = result?.ok
        ? "Writer works — test text inserted."
        : result?.error || "Writer failed to insert text.";
    } catch (error) {
      status.textContent = "Could not reach WhatsApp. Refresh WhatsApp Web and try again.";
    }
  });

  document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
});
