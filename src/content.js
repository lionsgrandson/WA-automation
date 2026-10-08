(() => {
  const state = {
    settings: null,
    processing: false,
    activeChatName: "",
    pendingUnreadOpen: false,
    initializedChats: new Set(),
    lastProcessedByChat: new Map(),
    lastReplyAtByChat: new Map(),
    timer: null,
    badge: null
  };

  start().catch((error) => {
    console.error("[WA Automation] startup failed:", error);
    showBadge("ERROR", error?.message || String(error), true);
  });

  async function start() {
    state.settings = await loadSettings();
    installBadge();
    updateBadge();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      state.settings = { ...(state.settings || {}) };
      for (const [key, change] of Object.entries(changes || {})) {
        if (!change) continue;
        state.settings[key] = change.newValue;
      }
      updateBadge();
      scheduleTick(50);
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "WA_STATUS") {
        const conversation = readConversation();
        sendResponse({
          ok: true,
          enabled: Boolean(state.settings?.enabled),
          processing: state.processing,
          chatName: conversation?.chatName || "",
          messageCount: conversation?.messages?.length || 0
        });
        return;
      }

      if (message?.type === "WA_TEST_WRITE") {
        insertReply(message.text || "WA Automation test message")
          .then((written) => {
            showBadge(
              written ? "WRITE OK" : "WRITE FAILED",
              written ? "Test text was inserted" : "Composer rejected test text",
              !written
            );
            sendResponse({ ok: written });
          })
          .catch((error) => {
            showBadge("WRITE ERROR", error?.message || String(error), true);
            sendResponse({ ok: false, error: error?.message || String(error) });
          });
        return true;
      }

      if (message?.type === "WA_DIAGNOSE_CHAT") {
        const diagnostic = diagnoseCurrentChat();
        const summary = diagnostic.chatName
          ? `${diagnostic.chatName}: ${diagnostic.total} messages (${diagnostic.incoming} in / ${diagnostic.outgoing} out / ${diagnostic.unknown} unknown)`
          : "No open chat detected";

        showBadge(
          diagnostic.total > 0 ? "DIAGNOSTIC" : "NO MESSAGES",
          summary,
          diagnostic.total === 0
        );
        sendResponse({ ok: true, diagnostic });
        return;
      }
    });

    const observer = new MutationObserver(() => scheduleTick(250));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    state.timer = setInterval(tick, 1800);
    scheduleTick(800);
    log("ready", "WA Automation content script loaded.");
    console.info("[WA Automation] content script connected.");
  }

  async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not load extension settings.");
    }
    return response?.settings || {};
  }

  function scheduleTick(delay) {
    clearTimeout(scheduleTick.pending);
    scheduleTick.pending = setTimeout(() => {
      tick().catch((error) => {
        console.error("[WA Automation] tick failed:", error);
        showBadge("ERROR", error?.message || String(error), true);
      });
    }, delay);
  }

  async function tick() {
    if (state.processing) return;

    updateBadge();

    if (!state.settings?.enabled) return;

    const conversation = readConversation();

    if (conversation) {
      const chatChanged = conversation.chatName !== state.activeChatName;
      state.activeChatName = conversation.chatName;

      if (!state.initializedChats.has(conversation.chatName)) {
        state.initializedChats.add(conversation.chatName);

        if (!state.pendingUnreadOpen) {
          if (conversation.latestInbound) {
            state.lastProcessedByChat.set(
              conversation.chatName,
              messageKey(conversation.chatName, conversation.latestInbound)
            );
          }
        }
      }

      if (chatChanged && state.pendingUnreadOpen) {
        state.pendingUnreadOpen = false;
      }

      if (conversation.latestInbound && conversation.isActionable) {
        const key = messageKey(conversation.chatName, conversation.latestInbound);
        if (state.lastProcessedByChat.get(conversation.chatName) !== key) {
          await processConversation(conversation, key);
          return;
        }
      }
    }

    const unreadRow = findUnreadChatRow();
    if (unreadRow) {
      state.pendingUnreadOpen = true;
      clickChatRow(unreadRow);
      showBadge("OPENING", "Opening unread chat…");
      await sleep(700);
      scheduleTick(100);
    }
  }

  function readConversation() {
    const chatName = getChatName();
    if (!chatName) return null;

    if (state.settings?.skipGroups && looksLikeGroupChat()) {
      return { chatName, latestInbound: null, messages: [], isActionable: false };
    }

    const messageNodes = getMessageNodes();
    if (!messageNodes.length) return null;

    const messages = [];
    for (const node of messageNodes.slice(-40)) {
      const direction = getDirection(node);
      const text = getMessageText(node);
      if (!direction || !text) continue;

      messages.push({
        direction,
        text,
        id:
          node.getAttribute?.("data-id") ||
          node.querySelector?.("[data-id]")?.getAttribute("data-id") ||
          node.closest?.("[data-id]")?.getAttribute("data-id") ||
          ""
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
    showBadge("THINKING", `Replying to ${conversation.chatName}…`);

    try {
      const lastReplyAt = state.lastReplyAtByChat.get(conversation.chatName) || 0;
      const minimumMs = Math.max(5, Number(state.settings.minReplyIntervalSec) || 20) * 1000;
      const elapsed = Date.now() - lastReplyAt;

      if (elapsed < minimumMs) {
        const remaining = minimumMs - elapsed;
        showBadge("COOLDOWN", `Retrying in ${Math.ceil(remaining / 1000)}s`);
        setTimeout(() => scheduleTick(50), remaining + 100);
        return;
      }

      showBadge("READING", "Re-reading recent conversation…");

      const freshConversation = await readStableConversation(conversation.chatName);
      const contextConversation =
        freshConversation && freshConversation.chatName === conversation.chatName
          ? freshConversation
          : conversation;

      const contextLimit = Math.max(
        3,
        Math.min(30, Number(state.settings.maxConversationMessages) || 12)
      );

      const contextMessages = contextConversation.messages.slice(-contextLimit);

      showBadge(
        "THINKING",
        `Using the last ${contextMessages.length} message${contextMessages.length === 1 ? "" : "s"}…`
      );

      const response = await chrome.runtime.sendMessage({
        type: "GENERATE_REPLY",
        chatName: contextConversation.chatName,
        messages: contextMessages
      });

      if (!response?.ok) throw new Error(response?.error || "Reply generation failed.");

      const result = response.result;
      if (!result?.reply) throw new Error("Gemini returned an empty reply.");

      const inserted = await insertReply(result.reply);
      if (!inserted) {
        throw new Error("WhatsApp composer was found, but the generated text did not stay in the editor.");
      }

      const shouldSend = Boolean(state.settings.autoSend);

      if (shouldSend) {
        showBadge(
          "SENDING",
          result.needsHuman ? "Sending reply; human follow-up flagged…" : "Sending reply…"
        );

        await sleep(350 + Math.floor(Math.random() * 450));

        const sent = await sendCurrentComposer();
        if (!sent) {
          throw new Error("Reply was written, but WhatsApp did not confirm that it was sent.");
        }

        state.lastReplyAtByChat.set(conversation.chatName, Date.now());
      }

      const processedConversation = readConversation();
      const processedLatest =
        processedConversation?.chatName === conversation.chatName
          ? processedConversation.latestInbound
          : contextConversation.latestInbound;

      const processedKey = processedLatest
        ? messageKey(conversation.chatName, processedLatest)
        : key;

      state.lastProcessedByChat.set(conversation.chatName, processedKey);

      showBadge(
        shouldSend ? "SENT" : "DRAFTED",
        shouldSend
          ? (result.needsHuman ? "Reply sent; human follow-up flagged" : "Reply sent")
          : (result.needsHuman ? "Draft needs human review" : "Reply drafted")
      );

      log(
        shouldSend ? "sent" : "drafted",
        shouldSend
          ? `Auto-sent reply to ${conversation.chatName}`
          : `Drafted reply for ${conversation.chatName}${result.needsHuman ? " (human review requested)" : ""}`,
        { model: result.model, confidence: result.confidence, reason: result.reason }
      );
    } catch (error) {
      console.error("[WA Automation]", error);
      showBadge("ERROR", error?.message || String(error), true);
      log("error", error?.message || String(error));
    } finally {
      state.processing = false;
      setTimeout(updateBadge, 3500);
    }
  }

  async function readStableConversation(expectedChatName) {
    let lastSignature = "";
    let stablePasses = 0;
    let latest = null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(attempt === 0 ? 250 : 180);

      const current = readConversation();
      if (!current || current.chatName !== expectedChatName) return latest;

      latest = current;

      const tail = current.messages.slice(-6);
      const signature = tail
        .map((message) => `${message.direction}:${message.id || simpleHash(message.text)}`)
        .join("|");

      if (signature === lastSignature) {
        stablePasses += 1;
        if (stablePasses >= 2) return current;
      } else {
        stablePasses = 0;
        lastSignature = signature;
      }
    }

    return latest;
  }

  function getChatName() {
    const main = document.querySelector("#main") || document.querySelector('[role="main"]') || document.body;
    const selectors = [
      'header [data-testid="conversation-info-header-chat-title"]',
      'header span[title]',
      'header [title]',
      '[data-testid="conversation-header"] span[title]'
    ];

    for (const selector of selectors) {
      const elements = [...main.querySelectorAll(selector)].filter(isVisible);
      for (const element of elements) {
        const value = element.getAttribute("title") || element.textContent;
        if (value?.trim()) return value.trim();
      }
    }

    return "";
  }

  function looksLikeGroupChat() {
    const main = document.querySelector("#main") || document.querySelector('[role="main"]');
    const header = main?.querySelector("header");
    if (!header) return false;

    if (header.querySelector('[data-testid*="group"], [data-icon*="group"]')) return true;

    const secondary = [...header.querySelectorAll("span")]
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
      .find((text) => text.includes(",") && text.length > 10);

    return Boolean(secondary);
  }

  function getMessageNodes() {
    const main = document.querySelector("#main") || document.querySelector('[role="main"]') || document;

    const directMessages = [...main.querySelectorAll(".message-in, .message-out")];
    if (directMessages.length) return dedupeMessageNodes(directMessages);

    const msgContainers = [...main.querySelectorAll('[data-testid="msg-container"]')];
    if (msgContainers.length) return dedupeMessageNodes(msgContainers);

    const textAnchors = [
      ...main.querySelectorAll('[data-pre-plain-text], .selectable-text, [data-testid="msg-text"]')
    ];

    const wrappers = textAnchors
      .map(findMessageWrapper)
      .filter(Boolean);

    return dedupeMessageNodes(wrappers);
  }

  function findMessageWrapper(node) {
    let current = node;

    for (let i = 0; current && i < 12; i += 1, current = current.parentElement) {
      if (
        current.classList?.contains("message-in") ||
        current.classList?.contains("message-out") ||
        current.hasAttribute?.("data-id") ||
        current.getAttribute?.("data-testid") === "msg-container"
      ) {
        return current;
      }
    }

    return node.closest?.('[role="row"], [role="listitem"]') || node.parentElement;
  }

  function dedupeMessageNodes(nodes) {
    const seen = new Set();
    const result = [];

    for (const node of nodes) {
      const anchor =
        node.querySelector?.("[data-pre-plain-text]") ||
        node.querySelector?.(".selectable-text") ||
        node.querySelector?.('[data-testid="msg-text"]') ||
        node;

      const key =
        node.getAttribute?.("data-id") ||
        anchor.getAttribute?.("data-pre-plain-text") ||
        `${getMessageText(node)}|${result.length}`;

      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(node);
    }

    return result;
  }

  function getDirection(node) {
    if (node.classList?.contains("message-in") || node.closest?.(".message-in")) return "in";
    if (node.classList?.contains("message-out") || node.closest?.(".message-out")) return "out";

    const wrapper = findMessageWrapper(node);
    const dataId =
      wrapper?.getAttribute?.("data-id") ||
      wrapper?.querySelector?.("[data-id]")?.getAttribute("data-id") ||
      node.getAttribute?.("data-id") ||
      "";

    if (/^true_/i.test(dataId) || /_true_/i.test(dataId)) return "out";
    if (/^false_/i.test(dataId) || /_false_/i.test(dataId)) return "in";

    const outgoingMarker = wrapper?.querySelector?.(
      '[aria-label="You:"], [aria-label="You"], [aria-label^="You:"], [aria-label^="אתה:"], [aria-label^="את:"], [data-testid="msg-check"], [data-icon="msg-check"], [data-icon="msg-dblcheck"]'
    );
    if (outgoingMarker) return "out";

    const preNode =
      wrapper?.querySelector?.("[data-pre-plain-text]") ||
      node.closest?.("[data-pre-plain-text]") ||
      node.querySelector?.("[data-pre-plain-text]");

    const pre = preNode?.getAttribute?.("data-pre-plain-text") || "";

    if (/\bYou\s*:/i.test(pre) || /(?:^|\s)(?:אתה|את)\s*:/i.test(pre)) return "out";

    // If WhatsApp exposes a text bubble but none of the outgoing signals are present,
    // treat it as incoming only when the enclosing block looks like a message row.
    if (
      wrapper &&
      (wrapper.querySelector?.(".selectable-text, [data-testid='msg-text'], [data-pre-plain-text]") ||
        wrapper.matches?.("[data-pre-plain-text]"))
    ) {
      return "in";
    }

    return null;
  }

  function getMessageText(node) {
    const candidates = [];

    if (node.matches?.(".selectable-text, [data-testid='msg-text']")) candidates.push(node);
    candidates.push(
      ...(node.querySelectorAll?.(".selectable-text, [data-testid='msg-text']") || [])
    );

    for (const candidate of candidates) {
      const text = candidate.innerText || candidate.textContent || "";
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean) return clean;
    }

    const preNodes = [];
    if (node.matches?.("[data-pre-plain-text]")) preNodes.push(node);
    preNodes.push(...(node.querySelectorAll?.("[data-pre-plain-text]") || []));

    for (const candidate of preNodes) {
      const text = candidate.innerText || candidate.textContent || "";
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean) return clean;
    }

    return "";
  }

  function diagnoseCurrentChat() {
    const chatName = getChatName();
    const nodes = getMessageNodes();
    const details = [];
    let incoming = 0;
    let outgoing = 0;
    let unknown = 0;

    for (const node of nodes.slice(-20)) {
      const direction = getDirection(node);
      const text = getMessageText(node);

      if (direction === "in") incoming += 1;
      else if (direction === "out") outgoing += 1;
      else unknown += 1;

      details.push({
        direction: direction || "unknown",
        text: text.slice(0, 120),
        className: String(node.className || "").slice(0, 160),
        dataId: node.getAttribute?.("data-id") || ""
      });
    }

    return {
      chatName,
      total: nodes.length,
      incoming,
      outgoing,
      unknown,
      latestDirection: details.at(-1)?.direction || "none",
      latestText: details.at(-1)?.text || "",
      details
    };
  }

  function findUnreadChatRow() {
    const pane = document.querySelector("#pane-side") || document.querySelector('[aria-label*="chat list" i]');
    if (!pane) return null;

    const selectors = [
      '[data-testid*="unread"]',
      '[data-icon*="unread"]',
      '[aria-label*="unread" i]'
    ];

    for (const selector of selectors) {
      const markers = [...pane.querySelectorAll(selector)];
      for (const marker of markers) {
        const row = ascendToChatRow(marker, pane);
        if (row && isVisible(row)) return row;
      }
    }

    const rows = [...pane.querySelectorAll('[role="listitem"], [role="row"], [tabindex="0"]')];
    for (const row of rows) {
      const text = [
        row.getAttribute("aria-label") || "",
        row.textContent || ""
      ].join(" ");

      if (/\bunread\b/i.test(text) && isVisible(row)) return row;

      const badge = [...row.querySelectorAll("span, div")].find((el) => {
        const value = (el.getAttribute("aria-label") || "").trim();
        return /unread/i.test(value);
      });

      if (badge && isVisible(row)) return row;
    }

    return null;
  }

  function ascendToChatRow(element, pane) {
    let current = element;

    for (let i = 0; current && current !== pane && i < 12; i += 1, current = current.parentElement) {
      if (
        current.getAttribute?.("role") === "listitem" ||
        current.getAttribute?.("role") === "row" ||
        current.matches?.('[data-testid="cell-frame-container"]')
      ) {
        return current;
      }
    }

    return element.closest?.('[role="listitem"], [role="row"], [tabindex="0"]') || null;
  }

  function clickChatRow(row) {
    const target =
      row.querySelector?.('[tabindex="0"]') ||
      row.querySelector?.('[role="button"]') ||
      row;

    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    target.click();
  }

  async function insertReply(text) {
    const expected = normalizeComposerText(text);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const composer = findComposer();
      if (!composer) {
        await sleep(180);
        continue;
      }

      composer.focus({ preventScroll: true });
      await sleep(40);

      selectAllComposerText(composer);

      let inserted = false;

      try {
        inserted = document.execCommand("insertText", false, text);
      } catch {
        inserted = false;
      }

      if (!inserted) {
        try {
          composer.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: text
            })
          );
          inserted = document.execCommand("insertText", false, text);
        } catch {
          inserted = false;
        }
      }

      await sleep(180);

      const freshComposer = findComposer();
      const actual = normalizeComposerText(
        freshComposer?.innerText ||
        freshComposer?.textContent ||
        ""
      );

      if (actual === expected || actual.includes(expected)) {
        console.info(`[WA Automation] composer write verified on attempt ${attempt}`);
        return true;
      }

      console.warn(
        `[WA Automation] composer write attempt ${attempt} did not stick.`,
        { inserted, actual, expected }
      );

      await sleep(180);
    }

    return false;
  }

  function selectAllComposerText(composer) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function normalizeComposerText(value) {
    return String(value || "")
      .replace(/\u200B/g, "")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function findComposer() {
    const main = document.querySelector("#main") || document.querySelector('[role="main"]') || document;
    const selectors = [
      '#main footer div[contenteditable="true"][data-tab="10"]',
      'footer div[contenteditable="true"][data-tab="10"]',
      'footer [contenteditable="true"][role="textbox"]',
      '[data-testid="conversation-compose-box-input"]',
      'footer div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]'
    ];

    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)].filter((node) => {
        if (!isVisible(node)) return false;
        if (node.getAttribute("contenteditable") !== "true") return false;

        const rect = node.getBoundingClientRect();
        return rect.top > window.innerHeight * 0.45;
      });

      if (nodes.length) return nodes[nodes.length - 1];
    }

    return null;
  }

  async function sendCurrentComposer() {
    const beforeComposer = findComposer();
    const draftText = normalizeComposerText(
      beforeComposer?.innerText || beforeComposer?.textContent || ""
    );

    if (!beforeComposer || !draftText) {
      console.warn("[WA Automation] send aborted: composer is empty.");
      return false;
    }

    const beforeOutgoing = captureOutgoingMessageKeys();

    // The WhatsApp footer can remount after text is inserted, so wait for the
    // real Send control to appear before trying to click it.
    let sendControl = null;
    for (let i = 0; i < 12; i += 1) {
      sendControl = findSendControl();
      if (sendControl) break;
      await sleep(150);
    }

    if (!sendControl) {
      console.error(
        "[WA Automation] send button not found.",
        describeFooterControls()
      );
      showBadge("SEND ERROR", "Send button not found", true);
      return false;
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // Always resolve a fresh live control. WhatsApp may have replaced the
      // previous node between attempts.
      sendControl = findSendControl();

      if (!sendControl) {
        console.error(
          "[WA Automation] send button disappeared before click.",
          describeFooterControls()
        );
        return false;
      }

      showBadge("SENDING", `Clicking Send… attempt ${attempt}`);

      try {
        sendControl.click();
      } catch (error) {
        console.error("[WA Automation] send button click failed:", error);
        return false;
      }

      // Wait for WhatsApp to create a new outgoing message. This is a much
      // stronger success signal than merely seeing the composer clear.
      for (let check = 0; check < 14; check += 1) {
        await sleep(150);

        if (hasNewOutgoingReply(beforeOutgoing, draftText)) {
          console.info(
            `[WA Automation] outgoing reply verified after send attempt ${attempt}`
          );
          return true;
        }

        const composerText = getComposerText();

        // The composer being empty is still useful as a secondary success
        // signal because WhatsApp sometimes mounts the outgoing bubble slightly
        // after clearing the editor.
        if (!composerText) {
          for (let lateCheck = 0; lateCheck < 8; lateCheck += 1) {
            await sleep(150);
            if (hasNewOutgoingReply(beforeOutgoing, draftText)) {
              console.info(
                `[WA Automation] outgoing reply verified after composer clear on attempt ${attempt}`
              );
              return true;
            }
          }

          // WhatsApp accepted the click and cleared the editor. Do not click
          // again, because a second click could create a duplicate.
          console.info(
            "[WA Automation] composer cleared after click; treating send as successful."
          );
          return true;
        }
      }

      // Only retry when the exact draft is still present. If WhatsApp changed
      // the editor state, avoid a second click to prevent duplicate sends.
      const remaining = getComposerText();
      if (!remaining.includes(draftText)) {
        return true;
      }

      await sleep(250);
    }

    console.error(
      "[WA Automation] send click did not produce a new outgoing message.",
      describeFooterControls()
    );
    return false;
  }

  function findSendControl() {
    const main =
      document.querySelector("#main") ||
      document.querySelector('[role="main"]') ||
      document;

    const selectors = [
      'footer button[aria-label="Send"]',
      'footer [role="button"][aria-label="Send"]',
      'footer button[aria-label="שליחה"]',
      'footer [role="button"][aria-label="שליחה"]',
      'footer [data-testid="compose-btn-send"]',
      'footer [data-testid="send"]',
      'footer span[data-icon="wds-ic-send-filled"]',
      'footer span[data-icon="send"]',
      'footer span[data-icon*="send"]'
    ];

    for (const selector of selectors) {
      const element = [...main.querySelectorAll(selector)].find(isVisible);
      if (!element) continue;

      const control =
        element.closest("button") ||
        element.closest('[role="button"]') ||
        element;

      if (isVisible(control)) return control;
    }

    const footer = main.querySelector("footer");
    if (!footer) return null;

    const candidates = [
      ...footer.querySelectorAll('button, [role="button"]')
    ].filter(isVisible);

    return (
      candidates.find((control) => {
        const label = [
          control.getAttribute("aria-label") || "",
          control.getAttribute("data-testid") || "",
          control.getAttribute("title") || "",
          control.textContent || ""
        ].join(" ");

        return (
          /(?:^|\s)(?:send|שליחה)(?:\s|$)/i.test(label) ||
          Boolean(control.querySelector('[data-icon="wds-ic-send-filled"], [data-icon="send"], [data-icon*="send"]'))
        );
      }) || null
    );
  }

  function captureOutgoingMessageKeys() {
    const conversation = readConversation();
    const keys = new Set();

    for (const message of conversation?.messages || []) {
      if (message.direction !== "out") continue;
      keys.add(messageKey(conversation.chatName || "", message));
    }

    return keys;
  }

  function hasNewOutgoingReply(beforeKeys, expectedText) {
    const conversation = readConversation();
    if (!conversation) return false;

    const expected = normalizeComposerText(expectedText);
    const expectedStart = expected.slice(0, Math.min(100, expected.length));

    for (const message of conversation.messages.slice(-8)) {
      if (message.direction !== "out") continue;

      const key = messageKey(conversation.chatName, message);
      if (beforeKeys.has(key)) continue;

      const actual = normalizeComposerText(message.text);

      if (
        actual === expected ||
        actual.includes(expected) ||
        expected.includes(actual) ||
        (expectedStart.length >= 20 && actual.includes(expectedStart))
      ) {
        return true;
      }
    }

    return false;
  }

  function getComposerText() {
    const composer = findComposer();
    return normalizeComposerText(
      composer?.innerText || composer?.textContent || ""
    );
  }

  function describeFooterControls() {
    const main =
      document.querySelector("#main") ||
      document.querySelector('[role="main"]') ||
      document;

    const footer = main.querySelector("footer");
    if (!footer) return { footer: false, controls: [] };

    const controls = [
      ...footer.querySelectorAll('button, [role="button"]')
    ].filter(isVisible);

    return {
      footer: true,
      controls: controls.slice(-12).map((control) => ({
        ariaLabel: control.getAttribute("aria-label") || "",
        testId: control.getAttribute("data-testid") || "",
        title: control.getAttribute("title") || "",
        icons: [...control.querySelectorAll("[data-icon]")]
          .map((icon) => icon.getAttribute("data-icon"))
          .filter(Boolean)
          .slice(0, 5)
      }))
    };
  }

  function installBadge() {
    if (document.getElementById("wa-automation-status")) {
      state.badge = document.getElementById("wa-automation-status");
      return;
    }

    const badge = document.createElement("div");
    badge.id = "wa-automation-status";
    badge.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:2147483647",
      "padding:7px 10px",
      "border-radius:8px",
      "font:12px/1.2 Arial,sans-serif",
      "background:#202c33",
      "color:#e9edef",
      "box-shadow:0 2px 10px rgba(0,0,0,.25)",
      "max-width:260px",
      "pointer-events:none",
      "opacity:.92"
    ].join(";");

    document.documentElement.appendChild(badge);
    state.badge = badge;
  }

  function updateBadge() {
    installBadge();

    if (!state.settings?.enabled) {
      showBadge("OFF", "Enable from the extension popup");
      return;
    }

    if (state.processing) {
      showBadge("THINKING", "Generating a reply…");
      return;
    }

    const mode = state.settings?.autoSend ? "ON · AUTO-SEND" : "ON · DRAFT";
    showBadge(
      state.settings?.awayMode ? `${mode} · AWAY` : mode,
      "Watching WhatsApp for new messages"
    );
  }

  function showBadge(label, detail = "", isError = false) {
    installBadge();
    if (!state.badge) return;

    state.badge.textContent = `WA Automation: ${label}${detail ? " — " + detail : ""}`;
    state.badge.style.background = isError ? "#5f1f1f" : "#202c33";
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

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(type, message, extra = {}) {
    chrome.runtime
      .sendMessage({
        type: "LOG_EVENT",
        event: { type, message, ...extra }
      })
      .catch(() => {});
  }
})();
