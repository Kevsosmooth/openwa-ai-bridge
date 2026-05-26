# Personas — the bot's voice

A **persona** is one JSON file that defines how your bot sounds. The bridge loads the file
named by the `PERSONA` setting in `.env` (`PERSONA=me` → `personas/me.json`).

Only `example.json` ships in this repo. Your own persona file is ignored by git (it's
personal), so copy the example and edit your copy:

```bash
cp personas/example.json personas/me.json
# then set PERSONA=me in .env
```

## Fields

| Field | What it is |
| --- | --- |
| `name` | The persona's name. Shown in `/health` and logs. |
| `language` | Language(s) the bot writes in, e.g. `["English"]` or `["English","Spanish"]`. |
| `timezone` | IANA timezone, e.g. `"America/New_York"`. Drives time-of-day awareness (morning/evening greetings). |
| `systemPrompt` | The voice/behavior instructions. A string, **or** an array of lines (joined with newlines — easier to read). |
| `examples` | 10–20 short real messages in this voice. This is the most important field — see below. |

## The `examples` are what make it sound human

An AI copies a voice far better from **examples** than from description. Telling it
"text casually" is weak; showing it 15 of your actual texts is strong — it picks up your
sentence length, punctuation, capitalization, emoji habits, and slang level automatically.

Good examples to paste in:

- Real messages **you** have sent (scroll your own chats and copy a spread of them).
- A mix: greetings, reactions, making plans, short replies. **Mostly statements and reactions, with only a couple of questions** — real texting isn't an interview.
- **Vary the length deliberately.** Include some two-word replies (`lol nah`, `facts`) alongside fuller ones. Sameness — every reply at the same medium length — is the #1 AI tell.
- Keep them short and natural. Include your quirks (lowercase, "lol", no period — whatever you actually do).

Avoid:

- Anything private or identifying you don't want the bot repeating patterns of.
- Long paragraphs — texts, not essays.
- All one type (e.g. only greetings) — give it range.

## Tips for `systemPrompt`

The clearest tells that an AI is texting, and the rules that defeat each one:

- **Sameness — every reply about the same medium length.** Tell it to vary length hard: most replies should be a few words or one short line; occasionally longer. Real texting is bursty.
- **Ending every message with a question.** Tell it explicitly *not* to ask a question every turn. Mostly just react, agree, or say its thing and stop.
- **Mirroring long messages with long replies.** Tell it not to escalate, not to give "mindset / hustle / energy" speeches, and not to agree with everything.
- **Ignoring something weird.** Tell it to react like a real person to anything strange, random, crude, or off-topic — call it out (`lol what`, `bro what are you on about`) instead of gliding past.
- **Stiff deflection when accused of being a bot.** Tell it to brush it off or clown back like a real person, never with a customer-service line.
- **Inventing facts.** Tell it not to make up details it can't actually know (addresses, links, exact times) — say it'll send later or ask.
- Tell it to **mirror the other person's language**, and end with: "Match the voice in the example texts below." so it leans on your samples.

## Applying changes

The persona is read at startup, so after editing your file restart the bridge (no rebuild needed — the file is bind-mounted):

```bash
docker compose restart bridge
```

Confirm it loaded with the health check (see [`../SETUP.md`](../SETUP.md), step 8) — it
shows the active `persona` name and `personaExamples` count.
