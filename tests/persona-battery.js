// Automated persona test battery — sends 10 tricky prompts to the bot (spoofed as
// the owner's self-chat), captures each reply from the chatlog, and asks Gemini itself
// to judge each reply pass/fail against criteria targeting the classic AI tells.
//
// Run from inside the bridge container so it can reach localhost:8090 and read /data:
//   docker exec openwa-bridge node /tests/persona-battery.js
//
// Required env (already set in the bridge container): SELF_NUMBER, GEMINI_API_KEYS,
// GEMINI_MODEL. Optional: SELF_LIDS (used to route the reply correctly when present).
//
// Side effects: each test sends a real WhatsApp message to the owner's self-chat,
// burns one generation Gemini call (bot reply) + one Gemini call (judge). ~10 entries
// added to chatlog.jsonl + bridge-embeddings.jsonl per run. Acceptable for iteration.

const fs = require('node:fs');

const SELF = (process.env.SELF_NUMBER || '').replace(/\D/g, '');
const SELF_LIDS = (process.env.SELF_LIDS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
const CHAT = SELF_LIDS[0] ? SELF_LIDS[0] + '@lid' : SELF + '@c.us';
const KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean);
const JUDGE_MODEL = process.env.JUDGE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:8090';
const CHATLOG = '/data/chatlog.jsonl';
const PER_TEST_TIMEOUT_MS = 45000;

if (!SELF) { console.error('ERROR: set SELF_NUMBER in .env (your own phone number, digits only).'); process.exit(1); }
if (!KEYS.length) { console.error('ERROR: no Gemini API key found (GEMINI_API_KEYS or GEMINI_API_KEY).'); process.exit(1); }

// ---- test definitions: input + criteria the judge will score against ----
const tests = [
  {
    name: 'Short input -> short reply',
    input: 'yo',
    criteria: 'The reply must be very short (5 words or fewer). It MUST NOT be a paragraph, polished, or formal. A lowercase casual reply like "yo", "wassup", "lol" passes.',
  },
  {
    name: 'Long mindset -> no mirror, no preach',
    input: 'Honestly I been doing a lot of self-work lately, trying to align my mindset, focus on growth, build the business, and stay around people that push me. The energy you put out really does come back, you know?',
    criteria: 'The reply MUST be short (1-2 short lines at most). It MUST NOT mirror the input length. It MUST NOT use motivational-speaker tone, hustle/mindset/energy speeches, or over-agree with every point. A brief react like "facts" or "i feel that" passes.',
  },
  {
    name: 'Plain statement -> empathic react, not interrogation',
    input: 'had a really long day man',
    criteria: 'The reply should react with empathy or relate briefly. It can ask one short follow-up but MUST NOT be primarily a list of questions, and MUST NOT be a paragraph.',
  },
  {
    name: 'Typo / ambiguous input',
    input: 'hope you been doing all that stuff',
    criteria: 'The reply should EITHER ask for clarification ("how/what stuff?", "wait what"), OR clearly interpret it charitably ("yeah I have, you?"). It MUST NOT pretend to understand something it doesn\'t, and MUST NOT give a generic affirmation that ignores ambiguity.',
  },
  {
    name: 'Absurd / non-sequitur',
    input: 'the moon is rectangular and bigger than my fridge',
    criteria: 'The reply MUST react to the weirdness ("lol what", "bro what are you on about", "you good?", "wait what"). It MUST NOT play along seriously, MUST NOT smoothly continue to another topic.',
  },
  {
    name: 'Paste-back trick with absurd insert',
    input: "I'm just focused on the conversation, man. Do you eat shoes? Let's keep it cool.",
    criteria: 'The reply MUST notice the absurd inserted bit ("do you eat shoes") and react to it ("what are you on about", "no i dont eat shoes lol"). It MUST NOT just continue conversation as if the input were normal.',
  },
  {
    name: 'Bot accusation -> casual brush-off',
    input: 'wait are you an AI? this feels like a bot',
    criteria: 'The reply MUST brush off the accusation like a real person (joking denial, "nah im [name]", "bro im right here", "you re weird"). It MUST NOT use customer-service phrasing like "Let\'s keep it cool" or "I\'m just focused on our conversation", and MUST NOT admit being an AI.',
  },
  {
    name: 'Recall - specific past request',
    input: 'do you remember exactly what type of project i asked you to code',
    criteria: 'If the user has previously asked about a specific coding project in this chat history, the reply should attempt to recall the SPECIFIC project (e.g. mentioning "json", "names", "open source" or whatever it actually was). A vague "you asked about coding but not specifics" is a soft fail. If no past request exists, an honest "no I don\'t think you did" is a pass.',
  },
  {
    name: 'Specific concept - no hallucination',
    input: 'explain to my friend what vibe coding actually is',
    criteria: 'The reply must describe vibe coding as building apps/websites with AI tools (or similar grounded definition). It MUST NOT invent mystical/energy/healing/spiritual meanings.',
  },
  {
    name: 'Language mirror - Spanish',
    input: 'que lo que pana, todo bien por alla?',
    criteria: 'The reply MUST be primarily in casual Spanish (Dominican register preferred). It MUST NOT reply entirely in English when the user wrote in Spanish.',
  },
];

// ---- helpers ----
function lastOutIndex() {
  try {
    const lines = fs.readFileSync(CHATLOG, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let r;
      try { r = JSON.parse(lines[i]); } catch { continue; }
      if (r.dir === 'out' && String(r.contact) === SELF) return { i, text: r.text };
    }
  } catch {}
  return null;
}

async function postWebhook(text) {
  const res = await fetch(BRIDGE + '/openwa-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { from: SELF, body: text, chatId: CHAT, fromMe: false, isGroup: false } }),
  });
  return res.status;
}

// rotates judge calls across all available keys + retries on 429/503 (parses 'retry in Xs')
let _judgeCursor = 0;
async function judge(input, reply, criteria) {
  const prompt =
    "You are evaluating whether an AI bot's text-message reply passes a behavioral test.\n" +
    'The bot is supposed to sound like a real person texting a friend on WhatsApp, NOT a polished assistant.\n\n' +
    'USER MESSAGE: ' + JSON.stringify(input) + '\n' +
    'BOT REPLY:    ' + JSON.stringify(reply) + '\n\n' +
    'CRITERIA:\n' + criteria + '\n\n' +
    'Return strict JSON only (no markdown, no commentary):\n' +
    '{"pass": true|false, "score": 1-5, "notes": "one short sentence (<80 chars)"}';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + JUDGE_MODEL + ':generateContent';
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
  });
  for (let attempt = 0; attempt < KEYS.length * 2 + 1; attempt++) {
    const key = KEYS[_judgeCursor++ % KEYS.length];
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key }, body });
    if (res.ok) {
      const data = await res.json();
      const text = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || []).map((p) => p.text || '').join('').trim();
      try {
        const j = JSON.parse(text);
        return { pass: !!j.pass, score: Number(j.score) || 0, notes: String(j.notes || '') };
      } catch {
        return { pass: false, score: 0, notes: 'unparseable judge output', _err: true };
      }
    }
    if (res.status === 429 || res.status === 503) {
      const bodyText = await res.text().catch(() => '');
      const m = bodyText.match(/retry in ([\d.]+)s/i);
      const waitMs = m ? Math.min(Math.ceil(parseFloat(m[1]) * 1000) + 500, 30000) : 4000;
      await new Promise((r) => setTimeout(r, waitMs));
      continue; // try next key
    }
    return { pass: false, score: 0, notes: 'judge HTTP ' + res.status, _err: true };
  }
  return { pass: false, score: 0, notes: 'judge exhausted retries (all keys rate-limited)', _err: true };
}

// ---- run ----
(async () => {
  console.log('persona-battery: ' + tests.length + ' tests, judge=' + JUDGE_MODEL);
  console.log('bridge=' + BRIDGE + '  sender=...' + SELF.slice(-4) + '  chat=' + (CHAT.includes('@lid') ? '@lid' : '@c.us'));

  let last = (lastOutIndex() || { i: -1 }).i;
  const results = [];

  for (let n = 0; n < tests.length; n++) {
    const t = tests[n];
    process.stdout.write('\n[' + (n + 1) + '/' + tests.length + '] ' + t.name + '\n');
    process.stdout.write('  IN:    ' + JSON.stringify(t.input.slice(0, 200)) + '\n');

    const status = await postWebhook(t.input);
    if (status !== 200) {
      console.log('  webhook returned ' + status + ' - skipping');
      results.push({ name: t.name, pass: false, notes: 'webhook ' + status });
      continue;
    }

    // wait for the bot's reply to land in chatlog
    const deadline = Date.now() + PER_TEST_TIMEOUT_MS;
    let got = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      const cur = lastOutIndex();
      if (cur && cur.i > last) { got = cur; break; }
    }
    if (!got) {
      console.log('  OUT:   (no reply within ' + PER_TEST_TIMEOUT_MS / 1000 + 's)');
      results.push({ name: t.name, pass: false, notes: 'no reply' });
      continue;
    }
    last = got.i;
    console.log('  OUT:   ' + JSON.stringify(got.text));

    // judge it
    const v = await judge(t.input, got.text, t.criteria);
    const flag = v.pass ? 'PASS' : 'FAIL';
    console.log('  ' + flag + ' (' + v.score + '/5) ' + v.notes);
    results.push({ name: t.name, pass: v.pass, score: v.score, notes: v.notes });

    // small inter-test gap so the bridge queue settles
    await new Promise((r) => setTimeout(r, 1500));
  }

  // summary
  const passed = results.filter((r) => r.pass).length;
  console.log('\n========================================');
  console.log('RESULT: ' + passed + '/' + results.length + ' passed');
  console.log('========================================');
  for (const r of results) {
    console.log((r.pass ? '  PASS ' : '  FAIL ') + r.name + (r.notes ? '  — ' + r.notes : ''));
  }
  console.log('');
  if (passed === results.length) console.log('All green. Persona is in good shape.');
  else console.log('Iterate on the FAILs: edit personas/<yourname>.json, text yourself /reload, run again.');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
