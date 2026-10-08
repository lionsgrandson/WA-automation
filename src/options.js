const ids = [
  "enabled",
  "autoSend",
  "awayMode",
  "skipGroups",
  "apiKey",
  "model",
  "fallbackModel",
  "businessName",
  "openingHours",
  "businessContext",
  "websiteUrl",
  "websiteKnowledge",
  "replyLanguage",
  "tone",
  "minReplyIntervalSec",
  "maxConversationMessages",
  "awayMessageHebrew",
  "awayMessageEnglish"
];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("testGemini").addEventListener("click", testGemini);
  document.getElementById("learnWebsite").addEventListener("click", learnWebsite);
  await load();
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!response?.ok) return setStatus("saveStatus", response?.error || "Could not load settings.", true);

  const settings = response.settings || {};
  for (const id of ids) {
    const input = document.getElementById(id);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(settings[id]);
    else input.value = settings[id] ?? "";
  }

  renderLearnedAt(settings.websiteLearnedAt);
}

async function save() {
  setStatus("saveStatus", "Saving...");
  const settings = readForm();
  const response = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  if (!response?.ok) return setStatus("saveStatus", response?.error || "Save failed.", true);
  setStatus("saveStatus", "Saved.");
}

async function testGemini() {
  await save();
  setStatus("geminiStatus", "Testing...");
  const response = await chrome.runtime.sendMessage({ type: "TEST_GEMINI" });
  if (!response?.ok) return setStatus("geminiStatus", response?.error || "Gemini test failed.", true);

  const result = response.result;
  setStatus(
    "geminiStatus",
    `OK via ${result.model}: ${result.reply}${result.needsHuman ? " (human review)" : ""}`
  );
}

async function learnWebsite() {
  const raw = document.getElementById("websiteUrl").value.trim();
  if (!raw) return setStatus("websiteStatus", "Enter a website URL first.", true);

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return setStatus("websiteStatus", "Invalid website URL.", true);
  }

  const originPattern = `${url.protocol}//${url.host}/*`;
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) return setStatus("websiteStatus", "Website permission was not granted.", true);

  await save();
  setStatus("websiteStatus", "Reading website...");

  const response = await chrome.runtime.sendMessage({ type: "LEARN_WEBSITE", url: url.href });
  if (!response?.ok) return setStatus("websiteStatus", response?.error || "Website learning failed.", true);

  document.getElementById("websiteKnowledge").value = response.websiteKnowledge || "";
  document.getElementById("websiteUrl").value = response.rootUrl || url.href;
  setStatus("websiteStatus", `Learned ${response.pages} page(s), ${response.characters.toLocaleString()} characters.`);
  await load();
}

function readForm() {
  const result = {};

  for (const id of ids) {
    const input = document.getElementById(id);
    if (!input) continue;

    if (input.type === "checkbox") result[id] = input.checked;
    else if (input.type === "number") result[id] = Number(input.value);
    else result[id] = String(input.value || "").trim();
  }

  return result;
}

function renderLearnedAt(value) {
  const el = document.getElementById("websiteLearnedAt");
  if (!value) {
    el.textContent = "Website has not been learned yet.";
    return;
  }

  const date = new Date(value);
  el.textContent = Number.isNaN(date.getTime())
    ? `Last learned: ${value}`
    : `Last learned: ${date.toLocaleString()}`;
}

function setStatus(id, message, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", isError);
}
