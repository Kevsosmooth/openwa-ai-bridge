# Training your bot's persona

This guide walks you through gathering everything needed to make a bot sound like a specific
real person (you, or any character). The persona is the bot's whole brain — identity, voice,
dialect, business facts, personality, and 15–20 real sample texts. Vague answers give a
vague bot; specific answers give one that actually sounds like the person.

When you're done you'll have a `personas/<yourname>.json` file. Set `PERSONA=<yourname>`
in `.env`, restart the bridge, and the bot is configured. Then run the automated test
battery (`tests/persona-battery.js`) to score it.

---

## 1. The interview

Walk through the person you're training the bot on (yourself, a client) and answer each.
Don't skip — every section maps to a concrete part of the persona file.

### Identity

- **First name** (what you go by in texts)
- **Age or birth year** (only if it's likely to come up — "born 1994" is enough)
- **Where you're from + where you live now** (e.g. "Brooklyn NYC, Dominican background")
- **What you do for work** (one short sentence)

### Voice & dialect

- **Languages you text in** — only English? casual Spanish too? code-switching?
- **Slang you use sometimes** ("fr", "lol", "deadass") **and slang you'd NEVER use** ("yo", "g", "bet")
- **Punctuation habits** (lowercase? periods? run-on lines?)
- **Emoji habits** (sparing / never / a lot)
- **Phrases that aren't yours** ("yo yo", "my g", em-dashes, "let me know")

### Business / profession (the hallucination-killer)

This section prevents the bot from inventing nonsense (the way it once turned "vibe coding"
into "energy healing"). For anything you do or talk about that has a SPECIFIC meaning:

- **What you do, briefly** — "wholesale business: selling X to Y"
- **Industry terms that mean something specific to you** — define them in one line.
  *Example:* `"vibe coding" just means building apps and websites using AI tools — NOT energy work, NOT mystical stuff`
- **Common questions people ask you about it** — how would you actually answer in 1–2 short lines?

### Personality & humor

- Joker / serious / blunt / caring / sarcastic? One line.
- What kind of jokes do you crack? (dry, wordplay, clowning, no jokes)
- When someone vents to you, do you validate or try to fix?

### Conversation style

- **Length** — most of your texts are: a few words / one line / multi-line?
- **Questions back** — do you usually ask follow-ups, or mostly react?
- **Reaction style** — what do you say when something's funny / weird / doesn't make sense?

### Things you'd never say

- Off-limits topics
- Phrases that aren't you ("let's keep it cool", "I'm here to help")
- Anything that sounds like customer service

---

## 2. Collecting sample texts (this is the magic)

The single biggest factor in sounding like the person: **15–20 of their actual sent texts.**
The AI learns the voice from examples far better than from descriptions.

Privacy: these go in `personas/<yourname>.json` — that file is **gitignored** so it never
ends up in the public repo. Only `personas/example.json` ships.

How to pick samples:

- **A spread of lengths.** Some 2-word ("lol nah", "facts"), some one-liners, a couple longer ones. Variety teaches "burstiness" — the rhythm that makes texting feel human.
- **A mix of tones.** A joke, a serious reply, a question back, a flat reaction, an apology.
- **Include the quirks.** If they don't capitalize, leave it lowercase. If they use "lmk" or "rn" — keep them. Typos and abbreviations are voice signals.
- **Avoid** anything sensitive that you'd be uncomfortable having the bot pattern-match on.

---

## 3. Build the persona file

Copy the template and fill it in:

```bash
cp personas/example.json personas/<yourname>.json
```

Schema:

```json
{
  "name": "Your name",
  "language": ["English", "Spanish"],
  "timezone": "America/New_York",
  "systemPrompt": [
    "You are <Name>, a real person texting friends and family on WhatsApp. Never an assistant, never a bot.",
    "HOW YOU TEXT: keep it short and uneven. Most replies a few words or one line; sometimes just 'lol' or 'fr'. Never a paragraph. Real texting is bursty.",
    "Don't end every message with a question. Mostly react; ask back only once in a while.",
    "Don't mirror their length. Long messages don't deserve long replies. No motivational tone, no over-agreeing.",
    "React like a real person to weird/absurd/crude input — 'lol what', 'bro what are you on about' — never glide past it.",
    "If accused of being a bot/AI, brush it off naturally ('nah im <name>', 'bro im right here'). NEVER 'let's keep it cool'.",
    "Don't invent facts. <Your business term> means <real meaning>, not <hallucinated thing>. If asked something specific you can't know, say you'll send it later.",
    "Style: lowercase ok, light punctuation, casual shortenings (rn, lmk, idk). Don't open with 'yo', don't use '<banned words>'.",
    "You: <identity facts — Brooklyn, Dominican, 1994, wholesale business, food/drink tastes, etc.>. Use only when they come up — never list them.",
    "If someone asks who you are, say it's <name> and ask who they are. Mirror their language."
  ],
  "examples": [
    "your real text 1",
    "...",
    "your real text 20"
  ]
}
```

Then point `.env` at it and restart:

```bash
# in .env:
PERSONA=<yourname>

# then:
docker compose restart bridge
```

Confirm it loaded:

```bash
docker exec openwa-api node -e "fetch('http://bridge:8090/health').then(r=>r.json()).then(j=>console.log('persona:',j.persona,'| examples:',j.personaExamples))"
```

---

## 4. Test it — `tests/persona-battery.js`

Once the persona is set, run the automated test battery. It sends 10 tricky prompts to
the bot (as if you texted yourself), captures each reply, and asks Gemini itself to **judge**
whether the reply passes — checking for the classic AI tells (paragraph-length mirroring,
constant questions, robotic deflections, hallucinations, ignoring absurd input, etc.).

Requires `SELF_NUMBER` set in `.env` so the script can spoof your sender.

```bash
docker exec openwa-bridge node /tests/persona-battery.js
```

You'll see PASS / FAIL per test with a one-line reason from the judge, plus a final score.
Aim for 9–10 / 10. Anything failing tells you what's still bot-ish.

See `tests/README.md` for what each scenario covers.

---

## 5. Iterate

The loop:

1. Edit `personas/<yourname>.json` (rules or examples).
2. Text yourself **`/reload`** — bot picks up the new persona in seconds.
3. Run the battery again — or just text the bot directly.
4. Look at what failed and tighten that specific rule, or add an example demonstrating it.
5. Repeat until it sounds right.

Most personas converge in 2–3 cycles.
