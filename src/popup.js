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
  document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
});
