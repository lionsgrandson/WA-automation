(() => {
  const state = {
    settings: null,
    processing: false,
    lastProcessedByChat: new Map(),
    lastReplyAtByChat: new Map(),
    timer: null
  };

  const UNREAD_SELECTORS = [
    '[data-testid="icon-unread-count"]',
    '[data-testid="unread-count"]',
    '[aria-label*="unread message" i]',
    '[aria-label*="unread messages" i]'
  ];

  start();

  async function start() {
    state.settings = await loadSettings();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      state.settings = { ...state.settings };
      for (const [key, change] of Object.entries(changes)) {
        state.settings[key] = change.newValue;
      }
    });

    const observer = new MutationObserver(() => scheduleTick(350));
    observer.observe(document.documentElement, { childList: true, subtree: true });

    state.timer = setInterval(tick, 2500);
    scheduleTick(1000);
    log("ready", "WA Automation content script loaded.");
  }

  async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    return response?.settings || {};
  }

  function scheduleTick(delay) {
    clearTimeout(scheduleTick.pending);
    scheduleTick.pending = setTimeout(tick, delay);
  }

  async function tick() {
    if (state.processing || !state.settings?.enabled) return;
    if (!document.querySelector("header")) return;

    const conversation = readConversation();
    if (conversation?.latestInbound && conversation.isActionable) {
      const key = messageKey(conversation.chatName, conversation.latestInbound);
      if (state.lastProcessedByChat.get(conversation.chatName) !== key) {
        await processConversation(conversation, key);
        return;
      }
    }

    const unreadRow = findUnreadChatRow();
    if (unreadRow) {
      unreadRow.click();
      await sleep(900);
    }
  }

  function readConversation() {
    const chatName = getChatName();
    if (!chatName) return null;

    if (state.settings.skipGroups && looksLikeGroupChat()) {
      return { chatName, latestInbound: null, messages: [], isActionable: false };
    }

    const messageNodes = getMessageNodes();
    if (!messageNodes.length) return null;

    const messages = [];
    for (const node of messageNodes.slice(-30)) {
      const direction = getDirection(node);
      const text = getMessageText(node);
      if (!direction || !text) continue;
      messages.push({
        direction,
        text,
        id: node.getAttribute("data-id") || node.querySelector("[data-id]")?.getAttribute("data-id") || ""
      });
    }

    if (!messages.length) return null;

    const latest = messages[messages.length - 1];
    const latestInbound = latest.direction === "in" ? latest : null;

    return {
      chatName,
      messages,
      latestInbound,
      isActionable: Boolean(latestInbound)
    };
  }

  async function processConversation(conversation, key) {
    state.processing = true;
    state.lastProcessedByChat.set(conversation.chatName, key);

    try {
      const lastReplyAt = state.lastReplyAtByChat.get(conversation.chatName) || 0;
      const minimumMs = Math.max(5, Number(state.settings.minReplyIntervalSec) || 20) * 1000;
      if (Date.now() - lastReplyAt < minimumMs) return;

      const response = await chrome.runtime.sendMessage({
        type: "GENERATE_REPLY",
        chatName: conversation.chatName,
        messages: conversation.messages.slice(-Math.max(2, Number(state.settings.maxConversationMessages) || 12))
      });

      if (!response?.ok) throw new Error(response?.error || "Reply generation failed.");
      const result = response.result;
      if (!result?.reply) throw new Error("Gemini returned an empty reply.");

      const inserted = insertReply(result.reply);
      if (!inserted) throw new Error("Could not find the WhatsApp message composer.");

      const shouldSend = Boolean(state.settings.autoSend) && !result.needsHuman;
      if (shouldSend) {
        await sleep(500 + Math.floor(Math.random() * 900));
        const sent = clickSend();
        if (!sent) throw new Error("Draft inserted, but the send button was not found.");
        state.lastReplyAtByChat.set(conversation.chatName, Date.now());
      }

      log(
        shouldSend ? "sent" : "drafted",
        shouldSend
          ? `Auto-sent reply to ${conversation.chatName}`
          : `Drafted reply for ${conversation.chatName}${result.needsHuman ? " (human review requested)" : ""}`,
        { model: result.model, confidence: result.confidence, reason: result.reason }
      );
    } catch (error) {
      log("error", error?.message || String(error));
    } finally {
      state.processing = false;
    }
  }

  function getChatName() {
    const selectors = [
      'header [data-testid="conversation-info-header-chat-title"]',
      "header span[title]",
      "header [title]"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.getAttribute("title") || element?.textContent;
      if (value?.trim()) return value.trim();
    }
    return "";
  }

  function looksLikeGroupChat() {
    const header = document.querySelector("header");
    if (!header) return false;
    if (header.querySelector('[data-testid*="group"], [data-icon*="group"]')) return true;

    const secondary = [...header.querySelectorAll("span")]
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
      .find((text) => text.includes(",") && text.length > 10);

    return Boolean(secondary);
  }

  function getMessageNodes() {
    const primary = [...document.querySelectorAll(".message-in, .message-out")];
    if (primary.length) return primary;

    return [...document.querySelectorAll('[data-testid="msg-container"]')];
  }

  function getDirection(node) {
    if (node.classList?.contains("message-in") || node.closest?.(".message-in")) return "in";
    if (node.classList?.contains("message-out") || node.closest?.(".message-out")) return "out";

    const dataId = node.getAttribute?.("data-id") || node.closest?.("[data-id]")?.getAttribute("data-id") || "";
    if (dataId.includes("true_")) return "out";
    if (dataId.includes("false_")) return "in";
    return null;
  }

  function getMessageText(node) {
    const preferred = node.querySelector?.(".selectable-text, [data-testid='msg-text']");
    let text = preferred?.innerText || preferred?.textContent || "";

    if (!text.trim()) {
      const copyable = node.querySelector?.("[data-pre-plain-text]");
      text = copyable?.innerText || "";
    }

    return text.replace(/\s+/g, " ").trim();
  }

  function findUnreadChatRow() {
    for (const selector of UNREAD_SELECTORS) {
      const badges = document.querySelectorAll(selector);
      for (const badge of badges) {
        const row = ascendToChatRow(badge);
        if (row && isVisible(row)) return row;
      }
    }
    return null;
  }

  function ascendToChatRow(element) {
    let current = element;
    for (let i = 0; current && i < 9; i += 1, current = current.parentElement) {
      if (
        current.getAttribute?.("role") === "listitem" ||
        current.getAttribute?.("role") === "row" ||
        current.matches?.('[data-testid="cell-frame-container"]')
      ) {
        return current;
      }
    }

    return element.closest?.("[tabindex='0']") || element.parentElement;
  }

  function insertReply(text) {
    const composer = findComposer();
    if (!composer) return false;

    composer.focus();
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    } catch {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }

    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function findComposer() {
    const selectors = [
      'footer [contenteditable="true"][role="textbox"]',
      'footer div[contenteditable="true"]',
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][role="textbox"]'
    ];

    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)].filter(isVisible);
      if (nodes.length) return nodes[nodes.length - 1];
    }
    return null;
  }

  function clickSend() {
    const selectors = [
      '[data-testid="send"]',
      'button[aria-label="Send"]',
      '[aria-label="Send"]',
      'span[data-icon="send"]'
    ];

    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find(isVisible);
      if (!element) continue;
      const button = element.closest("button, [role='button']") || element;
      button.click();
      return true;
    }
    return false;
  }

  function messageKey(chatName, message) {
    return `${chatName}|${message.id || ""}|${simpleHash(message.text)}`;
  }

  function simpleHash(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return String(hash);
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(type, message, extra = {}) {
    chrome.runtime.sendMessage({
      type: "LOG_EVENT",
      event: { type, message, ...extra }
    }).catch(() => {});
  }
})();
