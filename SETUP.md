# Set up your own WhatsApp AI auto-responder

This guide walks you from a fresh clone to a working bot that replies on WhatsApp **in
your own voice**, only to people you allow, with short- and long-term memory.

The project has two parts that run together with Docker:

- **The gateway** — connects to WhatsApp (you scan a QR once) and exposes a local API.
- **The bridge** — the AI brain. It receives incoming messages from the gateway, asks
  Google Gemini for a human-like reply (using your persona + memory), and sends it back.

You configure everything in two files: `.env` (settings + keys) and a persona file in
`personas/`. Nothing is hardcoded to any one person.

---

## Before you start

You need:

- **Docker** (with Docker Compose v2 — the `docker compose` command).
- **A WhatsApp account** you can scan a QR with. Use a number you're comfortable
  automating — ideally a spare/second number, not your main one. Automating WhatsApp is
  against their Terms, so there is always some account risk; do this with a number you can afford to lose.
- **One or more Google Gemini API keys** — free at <https://aistudio.google.com/apikey>.
  More keys = higher throughput (they're rotated automatically).

---

## Step 1 — Get the code and your settings file

```bash
git clone <this-repo-url>
cd whatsapp-github-projecty
cp .env.example .env
```

Open `.env` in an editor. You'll fill it in over the next steps. The whole bottom
section ("BRIDGE / AI AUTO-RESPONDER") is what the bot uses.

> **Reaching the dashboard from your phone:** by default the dashboard binds to
> `127.0.0.1` (this machine only). To open it from another device, set `BIND_HOST` in
> `.env` to your server's LAN IP (e.g. `BIND_HOST=192.168.1.50`) or `0.0.0.0`.

## Step 2 — Add your Gemini key(s)

In `.env`:

```bash
GEMINI_API_KEYS=key1,key2,key3   # one or many, comma-separated
```

## Step 3 — Start everything

```bash
# Build once, then start (auto-detects which services to run from your .env)
scripts/openwa.sh build
scripts/openwa.sh start

# Check it came up
scripts/openwa.sh status
```

You should see `openwa-api`, `openwa-dashboard`, `openwa-traefik`, and `openwa-bridge`
containers. The dashboard is at `http://<BIND_HOST>:2886` (e.g. `http://127.0.0.1:2886`).

## Step 4 — Connect WhatsApp (scan the QR)

1. Open the dashboard, go to **Sessions**, and **create a session** (give it any name).
2. **Start** the session and **scan the QR** with WhatsApp on your phone
   (WhatsApp → Settings → Linked devices → Link a device).
3. Wait until the session shows **ready/connected**.
4. **Copy the session ID** (the UUID shown for your session) — you need it next.

## Step 5 — Link the bridge to your session

The bridge needs two values from the gateway. Put them in `.env`:

```bash
# Gateway API key:
#   docker exec openwa-api cat /app/data/.api-key
BRIDGE_OPENWA_API_KEY=owa_k1_...

# The session ID you copied in step 4:
BRIDGE_SESSION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Step 6 — Create your persona (the bot's voice)

This is what makes it sound like *you* (or any character you want).

```bash
cp personas/example.json personas/me.json
```

Edit `personas/me.json` — set the name, timezone, the voice instructions, and **paste in
10–20 of your own real text messages** as `examples`. Those samples are the single most
important thing for sounding human. See [`personas/README.md`](./personas/README.md) for
how to write a good one.

Then point `.env` at it:

```bash
PERSONA=me
```

## Step 7 — Choose who it replies to

The bot **only** replies to numbers on your allow-list. Start with just your own number so
you can test safely. In `.env`:

```bash
# digits only, with country code, no "+". Comma-separated.
ALLOWED_NUMBERS=15551234567
```

(This seeds `bridge-data/allowlist.txt` on first run. After that, edit that file directly
to add/remove people — no restart needed.)

## Step 8 — Apply your config and verify

The bridge reads `.env` and the persona file at startup, so restart just the bridge:

```bash
docker compose up -d --no-deps bridge

# Health check — should show your persona, example count, and allow-list size
docker exec openwa-api node -e "fetch('http://bridge:8090/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"
```

Look for `persona`, `personaExamples`, `allowCount`, and `keys` > 0.

## Step 9 — Test it

**Option A — text yourself (no second phone).** Use WhatsApp's "Message yourself" chat.
The bot replies there tagged ` --AI`. This needs two settings in `.env`:

- `SELF_NUMBER=<your number>` — tags the bot's own self-replies and **prevents an infinite
  loop** (the bot has to recognize its own messages so it doesn't reply to itself). Required.
- `SELF_LIDS=<your account's own WhatsApp LID>` — lets the gateway forward your
  self-messages to the bot. WhatsApp delivers the "Message yourself" chat under a 15-digit
  internal ID (a "LID"), not your phone number.

If finding your self-LID is fiddly, just use Option B — it's the most reliable first test.

**Option B — text the bot from another phone** that's on your allow-list.

Watch either one live:

```bash
docker compose logs -f openwa-bridge
```

When it's behaving the way you want, add your real contacts to
`bridge-data/allowlist.txt` and you're live.

---

## How it works (the short version)

```
incoming WhatsApp message
  → gateway webhook → bridge
  → is the sender on your allow-list?  (auto-resolves WhatsApp privacy "LIDs")
  → wait ~12s in case they send more messages, then combine them
  → build context: recent chat + relevant older memories + time of day + your persona
  → Google Gemini writes a reply in your voice
  → wait a human-like moment, then send it back
```

Memory has two layers: a **recent window** per contact, and **long-term recall** (older
messages are embedded and the most relevant ones are pulled back in on each reply). If the
memory layer ever fails, the bot still replies — it just loses the extra context.

## Control it from your phone

If you set `SELF_NUMBER` to your own number, your WhatsApp "Message yourself" chat doubles as a
remote control. Text yourself:

- `/help` - show the menu
- `/pause` - stop the bot replying to everyone
- `/resume` - turn it back on

A pause survives restarts (it stays off until you `/resume`), and commands only work from your own
number - if a contact types `/pause`, nothing happens.

## Day-to-day

| Task | How |
| --- | --- |
| Pause / resume the bot | Text yourself `/pause` or `/resume` (needs `SELF_NUMBER` set) |
| Add/remove who it talks to | Edit `bridge-data/allowlist.txt` (live, no restart) |
| Change the voice | Edit your `personas/<name>.json`, then `docker compose up -d --no-deps bridge` |
| Watch it live | `docker compose logs -f openwa-bridge` |
| Health/status | `/health` (see step 8) |
| Stop / start / status | `scripts/openwa.sh stop` · `start` · `status` |

## Privacy & safety

- **Never commit your secrets or chats.** `.gitignore` already excludes `.env`,
  `bridge-data/` (your real conversations), and your personal `personas/*.json`. Only
  `personas/example.json` ships in the repo.
- If a key ever lands in a commit, **rotate it** (delete it in Google AI Studio and make a new one).
- The bot replies as a real person and never says it's a bot. Use it responsibly and only
  with people who would be okay with it.

## Troubleshooting

- **No reply to an allow-listed person.** Check the logs:
  `docker compose logs --since 5m openwa-bridge | grep -E 'IN |skip|RAG'`. A `skip` means
  the sender wasn't matched — WhatsApp sometimes delivers under a privacy "LID"; the bridge
  tries to auto-resolve it to the real number, so make sure their **real number** is on the
  allow-list.
- **`/health` shows `persona: "bot"`.** Your `PERSONA` name doesn't match a file in
  `personas/`, or the JSON is invalid. The bot falls back to a generic voice and logs why.
- **All replies stop.** Check `keysAvailable` in `/health`; if 0, your Gemini keys are
  rate-limited — add more keys to `GEMINI_API_KEYS`.
