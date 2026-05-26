# Persona test battery

Automated quality check for any persona you've configured. Sends 10 tricky prompts
to the bot (spoofed as your self-chat), captures each reply, and uses **Gemini itself
as the judge** to score whether the reply passes against the classic AI-tell criteria.

## How to run

```bash
docker exec openwa-bridge node /tests/persona-battery.js
```

Requirements (already in the bridge container if you followed `SETUP.md`):

- `SELF_NUMBER` in `.env` — your own phone number, digits only. The script spoofs the sender as you.
- `GEMINI_API_KEYS` (or `GEMINI_API_KEY`) — same keys the bot uses; the judge calls Gemini directly.

Optional env:

- `JUDGE_MODEL` — defaults to your `GEMINI_MODEL` (which defaults to `gemini-2.5-flash`).
- `BRIDGE_URL` — defaults to `http://localhost:8090` (correct when running inside the bridge container).

## What it does

For each of 10 scenarios:

1. POSTs a fake webhook to the bridge as if **you** texted yourself the prompt.
2. The bridge runs the full pipeline — allow-list, memory, persona prompt, Gemini.
3. The bot sends a real reply to your self-chat (you'll see it in WhatsApp).
4. The script reads the reply from `chatlog.jsonl` and asks Gemini to judge it against the
   test's criteria.
5. Prints `PASS / FAIL (score/5) — one-line reason`.
6. After all 10, prints a summary.

## What each test covers

| # | Scenario | Tell it's hunting for |
| --- | --- | --- |
| 1 | Short input → short reply | Bot writing paragraphs to a one-word ping |
| 2 | Long mindset message → no mirror | Bot matching length, motivational-speaker tone |
| 3 | Plain statement → not always a question back | Bot interrogating instead of reacting |
| 4 | Typo / ambiguous input | Bot pretending to understand or giving generic affirmation |
| 5 | Absurd / non-sequitur | Bot smoothly ignoring the weird part |
| 6 | Paste-back trick with weird insert | Bot continuing as if input made sense |
| 7 | Bot accusation | Stiff scripted deflection vs. real-person brush-off |
| 8 | Recall — specific past request | Vague summary vs. actually pulling the specifics |
| 9 | Specific concept clarity | Hallucinating ("vibe coding = energy healing") |
| 10 | Language mirror (Spanish input) | Replying in English when they wrote in Spanish |

## Costs & side effects

Each run:

- ~10 generation Gemini calls (the bot replying) + ~10 judge Gemini calls. ~few cents.
- ~10 user-side + ~10 model-side entries added to `bridge-data/chatlog.jsonl` and
  `bridge-data/bridge-embeddings.jsonl`. Acceptable for iteration; if it becomes noise
  you can trim those files (they're gitignored).
- Real WhatsApp messages are sent to your "Message yourself" chat. You'll see all 10
  test interactions there.

## Iteration loop

```
edit personas/<yourname>.json → text yourself /reload → re-run battery → look at FAILs → tune → repeat
```

Most personas converge in 2–3 cycles. See `../PERSONA-SETUP.md` for the persona authoring guide.
