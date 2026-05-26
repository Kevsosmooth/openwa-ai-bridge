# Future ideas

Things noted during development but deliberately deferred. Each entry has: **what** it is,
**why deferred**, and **what needs to happen** before bringing it in.

---

## 1. Campaign Messenger (bulk broadcasts)

**What:** A Campaigns / Templates / Contact-Groups system that sends the same message to
many contacts at once. UI is a 3-step wizard (pick contacts, write a template with
`{{variables}}`, send) with live progress tracking. Implementation source:
[`rizo8107/OpenWA-rizo`](https://github.com/rizo8107/OpenWA-rizo), 15 commits ahead of upstream.

**Why useful:** A real business use case once an account is on the WhatsApp Business API
(where bulk sends are sanctioned). Pairs naturally with the AI auto-responder for inbound replies.

**Why deferred:** A 2026-05-26 code review of the source flagged a critical bug — `dailyLimit`
is defined in config but **never enforced in the processor**. Combined with a 3-second
minimum send-delay default, the feature as shipped will fire unlimited messages in a single
batch and almost certainly get a personal (non-Business-API) WhatsApp number banned. Several
other gaps stack behind it.

**What to fix before merging:**

| Severity | Issue |
| --- | --- |
| HIGH | Implement `dailyLimit` enforcement — track sent count per day (Redis or DB), pause the campaign when the cap is reached, resume next day |
| HIGH | Raise the minimum send-delay default to ~15 s for non-Business-API sessions; allow shorter delays only when the session is explicitly flagged as Business |
| MED | Add FK constraints in the migration: `campaigns.template_id → templates.id` and `campaigns.contact_group_id → contact_groups.id` (orphaned-data risk) |
| MED | Add an `@RequireRole(OPERATOR)` auth check to `GET /campaigns` |
| MED | CSV upload: cap file size (~50 MB), stream-parse instead of buffering, validate phone formats, surface duplicate-handling decisions to the user |
| MED | Validate media URLs / sizes before send (otherwise malformed URLs crash the engine) |
| LOW | Escape template variable substitutions (`{{name}}`); validate `contactIds` actually exist before sending |

**Revisit when:** you have a real broadcast use case (likely a Business API account). At that
point either patch + port (a focused day of work) or pick a different broadcast tool that
already handles WhatsApp compliance properly.

---

## 2. Chat history sync (gateway → DB)

**What:** A `/sessions/:id/sync` endpoint that pulls the WhatsApp Web session's existing
chat history into the gateway DB so the dashboard can show real conversations.
Implementation source: [`lucascampodonico/OpenWA`](https://github.com/lucascampodonico/OpenWA), 4 commits ahead.

**Why useful:** Closes the "no inbox view" gap — today there's no UI to see your saved
messages, only the manual `GET /api/sessions/:id/messages` API.

**Why deferred:**

1. **Privacy preference** — owner doesn't want personal conversations automatically pulled
   into searchable storage.
2. **Two concrete bugs in the source code:**
   - `src/engine/adapters/whatsapp-web-js.adapter.ts` line ~837 has a hardcoded debug limit
     (`allChats.slice(0, 2)`) — only the first 2 chats get synced. Production blocker until removed.
   - In the same file (~line 872), `chatId` is set to `msg.from` instead of `chat.id`, which
     misroutes group messages.

**Revisit when:** the project genuinely needs an in-dashboard conversations view. Fix the
debug slice, fix the chatId assignment, move sync to a background job so the API call doesn't
block for hours on big histories.

---

## How to use this file

When you're ready to take one of these on: open the entry, follow the "fix before merging"
list, port the code from the source fork, run the test battery (`tests/persona-battery.js`)
to make sure nothing regressed on the AI side, and push.
