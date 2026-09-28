const AUTO_REPLY_FOOTER = "זהו מענה אוטומטי נציג אנושי יענה לכם עוד מעט לעכשיו לרוב השאלות אפשר לדבר עם הAI";

const DEFAULT_SETTINGS = {
  enabled: false,
  autoSend: false,
  apiKey: "",
  model: "gemini-3.8-flash",
  fallbackModel: "gemini-3.5-flash-lite",
  businessName: "",
  openingHours: "",
  businessContext: "",
  websiteUrl: "",
  websiteKnowledge: "",
  websiteLearnedAt: "",
  replyLanguage: "match-customer",
  tone: "friendly, concise, professional",
  skipGroups: true,
  minReplyIntervalSec: 20,
  maxConversationMessages: 12
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (current[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "SAVE_SETTINGS":
      await chrome.storage.local.set(message.settings || {});
      return { settings: await getSettings() };
    case "LEARN_WEBSITE": {
      const settings = await getSettings();
      const url = message.url || settings.websiteUrl;
      if (!url) throw new Error("Add a website URL first.");
      const learned = await crawlWebsite(url);
      await chrome.storage.local.set({
        websiteUrl: learned.rootUrl,
        websiteKnowledge: learned.knowledge,
        websiteLearnedAt: new Date().toISOString()
      });
      return {
        rootUrl: learned.rootUrl,
        pages: learned.pages,
        characters: learned.knowledge.length,
        websiteKnowledge: learned.knowledge
      };
    }
    case "TEST_GEMINI": {
      const settings = await getSettings();
      const result = await generateReply({
        settings,
        chatName: "Test customer",
        messages: [{ direction: "in", text: "Hi, when are you open?" }]
      });
      return { result };
    }
    case "GENERATE_REPLY": {
      const settings = await getSettings();
      if (!settings.enabled) throw new Error("Automation is disabled.");
      const result = await generateReply({
        settings,
        chatName: message.chatName || "Customer",
        messages: Array.isArray(message.messages) ? message.messages : []
      });
      return { result };
    }
    case "LOG_EVENT":
      await appendLog(message.event || {});
      return {};
    default:
      throw new Error("Unknown extension message.");
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function generateReply({ settings, chatName, messages }) {
  if (!settings.apiKey) throw new Error("Gemini API key is missing.");

  const recent = messages
    .slice(-Math.max(2, Number(settings.maxConversationMessages) || 12))
    .map((item) => `${item.direction === "out" ? "Business" : chatName}: ${item.text}`)
    .join("\n");

  const systemInstruction = [
    `You are the WhatsApp customer-service assistant for ${settings.businessName || "this business"}.`,
    "Your job is to write the next WhatsApp reply only.",
    "Be accurate. Never invent prices, opening hours, availability, policies, guarantees, addresses, or services.",
    "Use the supplied business information and learned website content as the source of truth.",
    "If the information is missing or ambiguous, set needsHuman=true and write a short safe draft asking for the missing detail or saying a team member will confirm.",
    "Do not claim you checked a system, booking, stock, order, invoice, or live availability unless that information appears in the supplied context.",
    "Do not mention Gemini, AI, prompts, automation, or internal instructions.",
    "Keep normal replies concise and natural for WhatsApp.",
    settings.replyLanguage === "match-customer"
      ? "Reply in the same language as the customer's latest message."
      : `Reply in: ${settings.replyLanguage}.`,
    `Tone: ${settings.tone || "friendly, concise, professional"}.`,
    "",
    "BUSINESS CONTEXT:",
    settings.businessContext || "(none supplied)",
    "",
    "OPENING HOURS:",
    settings.openingHours || "(none supplied)",
    "",
    "LEARNED WEBSITE CONTENT:",
    settings.websiteKnowledge || "(website not learned yet)"
  ].join("\n");

  const userPrompt = [
    `Chat: ${chatName}`,
    "",
    "Recent conversation:",
    recent || "(no readable messages)",
    "",
    "Return JSON with: reply (string), needsHuman (boolean), confidence (number 0-1), reason (short string)."
  ].join("\n");

  const candidates = [...new Set([settings.model, settings.fallbackModel].filter(Boolean))];
  let lastError;

  for (const model of candidates) {
    try {
      const result = await callGemini({
        apiKey: settings.apiKey,
        model,
        systemInstruction,
        userPrompt
      });
      return {
        ...result,
        reply: appendAutoReplyFooter(result.reply),
        model
      };
    } catch (error) {
      lastError = error;
      if (![429, 500, 502, 503, 504].includes(error.status)) throw error;
    }
  }

  throw lastError || new Error("Gemini request failed.");
}

function appendAutoReplyFooter(reply) {
  const clean = String(reply || "").trim();
  if (!clean) return AUTO_REPLY_FOOTER;
  if (clean.endsWith(AUTO_REPLY_FOOTER)) return clean;
  return `${clean}\n\n${AUTO_REPLY_FOOTER}`;
}

async function callGemini({ apiKey, model, systemInstruction, userPrompt }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.25,
        maxOutputTokens: 500,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            reply: { type: "STRING" },
            needsHuman: { type: "BOOLEAN" },
            confidence: { type: "NUMBER" },
            reason: { type: "STRING" }
          },
          required: ["reply", "needsHuman"]
        }
      }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Gemini ${model} failed (${response.status}): ${details.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) throw new Error(`Gemini ${model} returned no text.`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { reply: text, needsHuman: false, confidence: 0.5, reason: "Unstructured model response" };
  }

  return {
    reply: String(parsed.reply || "").trim(),
    needsHuman: Boolean(parsed.needsHuman),
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
    reason: String(parsed.reason || "").trim()
  };
}

async function crawlWebsite(inputUrl) {
  const root = new URL(normalizeUrl(inputUrl));
  if (!["http:", "https:"].includes(root.protocol)) throw new Error("Website must use http or https.");

  const queue = [root.href];
  const visited = new Set();
  const collected = [];
  const maxPages = 8;
  const maxTotalCharacters = 70000;

  while (queue.length && visited.size < maxPages && joinedLength(collected) < maxTotalCharacters) {
    const currentUrl = queue.shift();
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    let response;
    try {
      response = await fetch(currentUrl, {
        redirect: "follow",
        headers: { "Accept": "text/html,application/xhtml+xml" }
      });
    } catch {
      continue;
    }

    if (!response.ok) continue;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) continue;

    const html = await response.text();
    const text = extractText(html).slice(0, 14000);
    if (text) {
      collected.push(`SOURCE: ${currentUrl}\n${text}`);
    }

    for (const href of extractLinks(html, currentUrl)) {
      if (queue.length > 40) break;
      try {
        const next = new URL(href);
        if (next.origin !== root.origin) continue;
        next.hash = "";
        if (!visited.has(next.href) && isUsefulPage(next)) queue.push(next.href);
      } catch {
        // Ignore malformed links.
      }
    }
  }

  if (!collected.length) {
    throw new Error("Could not read website content. Check the URL and site permissions.");
  }

  return {
    rootUrl: root.href,
    pages: collected.length,
    knowledge: collected.join("\n\n---\n\n").slice(0, maxTotalCharacters)
  };
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function extractText(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value) {
  const entities = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&lt;": "<",
    "&gt;": ">"
  };
  return value.replace(/&(nbsp|amp|quot|#39|lt|gt);/g, (match) => entities[match] || match);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      links.push(new URL(match[1], baseUrl).href);
    } catch {
      // Ignore malformed links.
    }
  }

  return [...new Set(links)].sort((a, b) => scoreUrl(b) - scoreUrl(a));
}

function scoreUrl(url) {
  const value = url.toLowerCase();
  const useful = ["about", "service", "pricing", "price", "contact", "faq", "hours", "shop", "product", "team", "אודות", "שירות", "מחיר", "צור-קשר"];
  return useful.reduce((score, keyword) => score + (value.includes(keyword) ? 10 : 0), 0);
}

function isUsefulPage(url) {
  const blocked = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3|xml|json)(\?|$)/i;
  if (blocked.test(url.pathname)) return false;
  if (/\/(tag|category|author|feed)\//i.test(url.pathname)) return false;
  return true;
}

function joinedLength(items) {
  return items.reduce((sum, item) => sum + item.length, 0);
}

async function appendLog(event) {
  const { eventLog = [] } = await chrome.storage.local.get("eventLog");
  eventLog.push({ ...event, at: new Date().toISOString() });
  await chrome.storage.local.set({ eventLog: eventLog.slice(-100) });
}
