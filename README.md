# WA Automation

Chrome Manifest V3 extension that monitors WhatsApp Web, reads new incoming chats, generates a reply with Gemini using your business context, and either drafts or sends the reply.

## What it does

- Watches WhatsApp Web for incoming/unread chats.
- Opens a chat when WhatsApp exposes an unread marker in the DOM.
- Reads the recent visible conversation.
- Sends the relevant conversation text and configured business knowledge to Gemini.
- Replies in the customer's language by default.
- Uses `gemini-3.8-flash` by default with a configurable fallback model.
- Stores business context, opening hours, website knowledge, API key, and settings in Chrome extension local storage.
- Can crawl up to 8 same-origin pages from your website and cache the extracted text as business knowledge.
- Can run in draft-only mode or auto-send mode.
- If Gemini says the answer needs human confirmation, the extension drafts the reply instead of auto-sending it.
- Skips group chats by default using best-effort DOM heuristics.
- Avoids answering an old message just because you manually opened an existing chat.

## Install locally

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder containing `manifest.json`.
6. Open the extension settings.
7. Add your Gemini API key.
8. Add business name, opening hours, policies/services, and any other context.
9. Add your website URL and click **Learn website**.
10. Click **Test Gemini**.
11. Open `https://web.whatsapp.com/` and sign in normally.
12. Enable the automation from the popup.
13. Leave **Auto-send** off first and verify several drafted replies before enabling automatic sending.

## Gemini API

The extension calls the Gemini REST API directly from the extension service worker. The API key is not injected into the WhatsApp page.

Default primary model:

```
gemini-3.8-flash
```

Default fallback:

```
gemini-3.5-flash-lite
```

You can change both in Settings.

Create/manage a Gemini API key in Google AI Studio:
https://aistudio.google.com/app/apikey

Gemini API documentation:
https://ai.google.dev/gemini-api/docs

## Website learning

Website learning is deliberately user-triggered.

When you click **Learn website**, Chrome requests permission for that website origin. The extension then:

1. Reads the homepage.
2. Discovers same-origin links.
3. Prioritizes URLs that look like About, Services, Pricing, Contact, FAQ, Hours, Products, and similar pages.
4. Reads up to 8 HTML pages.
5. Strips scripts/styles/markup.
6. Stores up to about 70,000 characters locally as cached knowledge.

It does not continuously crawl the site in the background.

## Reply safety rules

The system prompt tells Gemini not to invent:

- prices;
- opening hours;
- stock or availability;
- policies;
- guarantees;
- addresses;
- live system/booking/order status.

If the supplied knowledge is not enough, Gemini is instructed to return `needsHuman=true`. In that case, the extension leaves a draft rather than auto-sending.

## Important limitations

### WhatsApp Web DOM

This project automates the WhatsApp Web interface. It is not the official WhatsApp Business Platform API.

WhatsApp can change its DOM, labels, selectors, or behavior without notice. The extension therefore uses several fallback selectors and semantic/ARIA hints, but future WhatsApp Web updates may still require selector maintenance.

For a business-critical production system, the official WhatsApp Business Platform is more stable than browser DOM automation.

### Terms and account risk

Review WhatsApp/Meta terms and automation rules for your account and use case before enabling automatic replies. Do not use this project for spam or unsolicited bulk messaging.

### Gemini free tier and privacy

Google's Gemini API documentation states that free-tier usage is available for certain models and that free-tier content may be used to improve Google products. That means customer messages submitted to Gemini on a free-tier project should be treated as data sent to a third-party AI processor.

Confirm that this is acceptable for your customers, contracts, and privacy obligations before enabling the automation.

The Gemini API key is stored in `chrome.storage.local`. It is not exposed to page JavaScript, but anyone with access to your Chrome profile/extension storage may be able to retrieve it.

## Development notes

There is no build step and no npm dependency. Reload the unpacked extension from `chrome://extensions` after changing source files.

Useful files:

- `manifest.json` — extension permissions and entry points.
- `src/background.js` — Gemini calls, settings, website crawler, logs.
- `src/content.js` — WhatsApp Web DOM monitoring, reading, drafting and sending.
- `src/options.*` — full configuration UI.
- `src/popup.*` — quick enable/auto-send controls.

## Initial test checklist

- Gemini test succeeds.
- Website learning returns useful text.
- Draft-only mode replies correctly in English.
- Draft-only mode replies correctly in Hebrew.
- Opening-hours questions use configured hours.
- Unknown questions become human-review drafts.
- Manually opening an old chat does not trigger a reply.
- Existing outgoing message prevents a duplicate reply.
- Group chats are skipped when the option is enabled.
- Auto-send only happens after draft-only testing is satisfactory.
