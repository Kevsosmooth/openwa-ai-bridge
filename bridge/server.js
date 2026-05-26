// OpenWA -> Gemini auto-responder bridge (zero-dependency, Node 22+).
//
// Flow: OpenWA fires a 'message.received' webhook here -> check the sender against
// an allow-list -> ask Gemini (WITH recent conversation history + retrieved long-term
// memory) for a reply -> send it back via OpenWA send-text after a human-like delay.
// Replies go out one at a time (serial queue) so no two land at once.
//
// Key rotation: multiple Gemini keys are tried with per-key cooldown on rate
// limits (failover pattern). Generation and embeddings have SEPARATE cooldown lanes
// so embedding throttling can never slow down actual replies.
// Conversation memory is two layers: (1) recent window kept in-bridge per contact,
// (2) long-term retrieval (RAG) over embeddings of past messages. RAG is strictly
// additive and fails open: if embedding/retrieval fails, the bot still replies.

const http = require('node:http');
const fs = require('node:fs');

const PORT = process.env.PORT || '8090';
const OPENWA_BASE = process.env.OPENWA_BASE || 'http://openwa-api:2785/api';
const OPENWA_API_KEY = process.env.OPENWA_API_KEY || '';
const OPENWA_SESSION_ID = process.env.OPENWA_SESSION_ID || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS || '';
const SYSTEM_PROMPT =
  (process.env.SYSTEM_PROMPT && process.env.SYSTEM_PROMPT.trim()) ||
  'You are a friendly person texting on WhatsApp. Keep replies short, casual, and human.';

// ---- persona: per-deployment voice loaded from a JSON file in personas/ ----
// PERSONA names a file in PERSONA_DIR (e.g. PERSONA=alex -> /personas/alex.json). When unset,
// the bot falls back to the single SYSTEM_PROMPT above, so existing setups are unaffected.
const PERSONA = (process.env.PERSONA || '').trim();
const PERSONA_DIR = process.env.PERSONA_DIR || '/personas';
const TIMEZONE = (process.env.TIMEZONE || '').trim(); // IANA tz fallback when a persona file omits one

// ---- long-term memory (RAG) config — all optional, safe defaults ----
const EMBED_ENABLED = process.env.EMBED_ENABLED !== '0'; // kill switch
const EMBED_MODEL = process.env.EMBED_MODEL || 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.EMBED_DIM || 768);
const RETRIEVE_K = Number(process.env.RETRIEVE_K || 4);
const RETRIEVE_MIN_SCORE = Number(process.env.RETRIEVE_MIN_SCORE || 0.5);
const RETRIEVE_ROLES = new Set(
  (process.env.RETRIEVE_ROLES || 'user').split(',').map((s) => s.trim()).filter(Boolean),
); // which message roles RAG retrieves; default 'user' stops the bot echoing its own past wording
const EMBED_MAX_CHARS = Number(process.env.EMBED_MAX_CHARS || 8000);
const EMBEDDINGS_FILE = '/data/bridge-embeddings.jsonl';

const onlyDigits = (s = '') => String(s).replace(/\D/g, '');
const SELF_NUMBER = onlyDigits(process.env.SELF_NUMBER || ''); // self-chat test: set to your own number to tag those replies '--AI'
const ALLOW_FILE = '/data/allowlist.txt';
// Seed the allowlist file from env on first run; after that the FILE is the source of
// truth, so numbers can be added/removed by editing it with NO restart needed.
try {
  if (!fs.existsSync(ALLOW_FILE)) {
    fs.writeFileSync(ALLOW_FILE, ALLOWED_NUMBERS.split(',').map(onlyDigits).filter(Boolean).join('\n') + '\n');
  }
} catch {}
let _allowCache = { set: new Set(), at: 0 };
function allowSet() {
  if (_allowCache.set.size && Date.now() - _allowCache.at < 5000) return _allowCache.set; // 5s cache
  try {
    const nums = fs.readFileSync(ALLOW_FILE, 'utf8').split(/[\s,]+/).map(onlyDigits).filter(Boolean);
    _allowCache = { set: new Set(nums), at: Date.now() };
  } catch {}
  return _allowCache.set;
}

// ---- pause switch: presence of this file = bot replies to no one (toggled via self-chat /pause /resume) ----
const PAUSE_FILE = '/data/paused';
function isPaused() {
  try {
    return fs.existsSync(PAUSE_FILE);
  } catch {
    return false;
  }
}
const mask = (n) => '...' + onlyDigits(n).slice(-4);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ---- load the active persona (voice + few-shot examples); fail-open to SYSTEM_PROMPT ----
function loadPersona() {
  const fallback = { name: 'bot', systemPrompt: SYSTEM_PROMPT, examples: [], timezone: TIMEZONE || 'America/New_York', language: [] };
  if (!PERSONA) return fallback; // no persona selected -> single SYSTEM_PROMPT (backward-compatible)
  try {
    const p = JSON.parse(fs.readFileSync(`${PERSONA_DIR}/${PERSONA}.json`, 'utf8'));
    const sp = Array.isArray(p.systemPrompt) ? p.systemPrompt.join('\n') : String(p.systemPrompt || '').trim();
    return {
      name: p.name || PERSONA,
      systemPrompt: sp || SYSTEM_PROMPT,
      examples: Array.isArray(p.examples) ? p.examples.filter((x) => typeof x === 'string' && x.trim()) : [],
      timezone: p.timezone || TIMEZONE || 'America/New_York',
      language: Array.isArray(p.language) ? p.language : p.language ? [p.language] : [],
    };
  } catch (e) {
    log('persona load failed, using SYSTEM_PROMPT:', e.message);
    return fallback;
  }
}
const persona = loadPersona();
// few-shot voice block, built once: example texts as STYLE references, NOT conversation turns
const FEWSHOT_BLOCK = persona.examples.length
  ? 'Here are real examples of how YOU text. Match this voice: sentence length, punctuation, ' +
    'capitalization, emoji use, and slang level. These are STYLE references only, NOT part of the ' +
    'conversation, so do not reply to them:\n' +
    persona.examples.map((t) => `- ${t}`).join('\n')
  : '';

// ---- vector math (cosine == dot once vectors are normalized) ----
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// ---- LID resolution + full chat log ----
// WhatsApp delivers some contacts under a 15-digit "LID" (e.g. 123456789012345@lid) instead of
// their phone number. OpenWA's contact list links the two (one contact id carries both a real
// `number` and a LID `number`). Cache that mapping so an incoming LID resolves to the real number
// for the allow-list check, and so /outbound sends to the address that actually delivers.
let _contacts = { lidToReal: new Map(), realToLid: new Map(), lids: new Set(), at: 0 };
async function refreshContacts() {
  try {
    const res = await fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION_ID}/contacts`, {
      headers: { 'x-api-key': OPENWA_API_KEY },
    });
    if (!res.ok) return log('contacts refresh:', res.status);
    const cs = await res.json();
    const lidToReal = new Map();
    const realToLid = new Map();
    const lids = new Set();
    for (const c of cs) {
      const real = onlyDigits(c.id); // contact id is <realnumber>@c.us
      const num = onlyDigits(c.number); // either the real number again, or the LID
      if (real && num && num !== real) {
        lidToReal.set(num, real); // LID -> real number
        realToLid.set(real, num); // real number -> LID
        lids.add(num);
      }
    }
    _contacts = { lidToReal, realToLid, lids, at: Date.now() };
    log('contacts refreshed:', lidToReal.size, 'LID<->number mappings');
  } catch (e) {
    log('contacts refresh failed:', e.message);
  }
}

const CHATLOG_FILE = '/data/chatlog.jsonl'; // full both-sides archive (bind-mounted -> survives restarts)
function chatlog(dir, contact, text) {
  try {
    fs.appendFileSync(CHATLOG_FILE, JSON.stringify({ t: new Date().toISOString(), dir, contact, text }) + '\n');
  } catch (e) {
    log('chatlog failed:', e.message);
  }
}

// ---- API key rotation: round-robin with per-key cooldown on rate limits ----
// Each key has TWO independent cooldown lanes: availableAt (generation) and
// embedAvailableAt (embeddings). An embedding 429 must never throttle replies.
const keys = GEMINI_KEYS.map((key, i) => ({ key, i, availableAt: 0, embedAvailableAt: 0 }));
let cursor = 0;
function pickKey() {
  const now = Date.now();
  for (let n = 0; n < keys.length; n++) {
    const idx = (cursor + n) % keys.length;
    if (keys[idx].availableAt <= now) {
      cursor = (idx + 1) % keys.length;
      return keys[idx];
    }
  }
  return null; // all cooling down
}
let embedCursor = 0;
function pickEmbedKey() {
  const now = Date.now();
  for (let n = 0; n < keys.length; n++) {
    const idx = (embedCursor + n) % keys.length;
    if (keys[idx].embedAvailableAt <= now) {
      embedCursor = (idx + 1) % keys.length;
      return keys[idx];
    }
  }
  return null;
}

async function askGemini(contents, extraSystem = '') {
  if (!keys.length) throw new Error('no Gemini keys configured');
  // voice -> few-shot examples -> (extraSystem = RAG facts + time hint). Real turns stay in `contents`.
  const base = FEWSHOT_BLOCK ? persona.systemPrompt + '\n\n' + FEWSHOT_BLOCK : persona.systemPrompt;
  const sys = extraSystem ? base + '\n\n' + extraSystem : base;
  let lastErr = 'all keys rate-limited';
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const k = pickKey();
    if (!k) break;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': k.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents,
          generationConfig: { temperature: 0.9, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
    if (res.status === 429 || res.status === 503) {
      const body = await res.text();
      const m = body.match(/retry in ([\d.]+)s/i);
      const cd = m ? Math.ceil(parseFloat(m[1]) * 1000) + 1000 : 60000;
      k.availableAt = Date.now() + cd;
      lastErr = `key#${k.i} ${res.status}, cooling ${Math.round(cd / 1000)}s`;
      log('rotate:', lastErr);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  }
  throw new Error(lastErr);
}

// ---- embeddings: returns a normalized Float32Array, or null on ANY failure (never throws) ----
async function embed(text) {
  if (!EMBED_ENABLED || !keys.length || !text) return null;
  const input = String(text).slice(0, EMBED_MAX_CHARS);
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const k = pickEmbedKey();
    if (!k) return null; // all embed lanes cooling -> skip, reply still works
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-goog-api-key': k.key },
          body: JSON.stringify({
            content: { parts: [{ text: input }] },
            taskType: 'SEMANTIC_SIMILARITY',
            outputDimensionality: EMBED_DIM,
          }),
          signal: ctrl.signal,
        },
      );
      if (res.status === 429 || res.status === 503) {
        const body = await res.text().catch(() => '');
        const m = body.match(/retry in ([\d.]+)s/i);
        const cd = m ? Math.ceil(parseFloat(m[1]) * 1000) + 1000 : 60000;
        k.embedAvailableAt = Date.now() + cd; // separate lane: never touches generation
        continue;
      }
      if (!res.ok) {
        log('embed', res.status);
        return null;
      }
      const data = await res.json();
      const vals = data?.embedding?.values;
      if (!Array.isArray(vals) || vals.length !== EMBED_DIM) return null;
      return normalize(vals);
    } catch (e) {
      log('embed fail', e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function sendWhatsApp(chatId, text) {
  const res = await fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION_ID}/messages/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': OPENWA_API_KEY },
    body: JSON.stringify({ chatId, text }),
  });
  if (!res.ok) throw new Error(`OpenWA send ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---- self-chat command console: the owner texts their OWN number to control the bot ----
// Only owner messages starting with '/' (or bare help/menu) reach here; everyone else is a normal chat.
const HELP_TEXT =
  'Options:\n' +
  '/pause - stop replying to everyone\n' +
  '/resume - start replying again\n' +
  '/help - show this menu';
async function handleCommand(text, chatId) {
  const cmd = text.trim().toLowerCase();
  let reply;
  if (cmd === '/help' || cmd === '/?' || cmd === 'help' || cmd === 'menu') {
    reply = HELP_TEXT;
  } else if (cmd === '/pause' || cmd === '/stop') {
    try { fs.writeFileSync(PAUSE_FILE, new Date().toISOString() + '\n'); } catch {}
    reply = "Paused. I won't reply to anyone until you send /resume.";
  } else if (cmd === '/resume' || cmd === '/start' || cmd === '/on') {
    try { fs.rmSync(PAUSE_FILE, { force: true }); } catch {}
    reply = 'Back on. Replying normally again.';
  } else {
    reply = 'Unknown command. Send /help for options.';
  }
  log('CMD', cmd, '->', reply.split('\n')[0]);
  try {
    await sendWhatsApp(chatId, reply + ' --AI'); // --AI suffix = loop-guard (gateway skips our own tagged sends)
  } catch (e) {
    log('CMD send failed:', e.message);
  }
}

// ---- per-contact conversation memory (Layer 1: recent window, in the bridge) ----
const HISTORY_MAX = 16; // last ~8 back-and-forths
const HISTORY_TTL = Number(process.env.HISTORY_TTL_MIN || 120) * 60 * 1000; // forget a thread after N min idle (default 2h)
const histories = new Map();
const HISTORY_FILE = '/data/bridge-histories.json'; // bind-mounted dir -> survives restarts
try {
  if (fs.existsSync(HISTORY_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')))) histories.set(k, v);
    log('loaded ' + histories.size + ' saved thread(s) from disk');
  }
} catch (e) {
  log('history load failed:', e.message);
}
let saveTimer = null;
function persistHistories() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(histories)));
    } catch (e) {
      log('history save failed:', e.message);
    }
  }, 2000);
}
function history(sender) {
  const h = histories.get(sender);
  if (!h || Date.now() - h.updated > HISTORY_TTL) {
    const fresh = { turns: [], updated: Date.now() };
    histories.set(sender, fresh);
    return fresh;
  }
  return h;
}
function remember(sender, role, text) {
  const h = history(sender);
  h.turns.push({ role, text });
  if (h.turns.length > HISTORY_MAX) h.turns = h.turns.slice(-HISTORY_MAX);
  h.updated = Date.now();
  persistHistories();
}

// ---- long-term memory (Layer 2: retrieval over embeddings, persisted to JSONL) ----
const vectors = []; // { id, sender, role, text, ts, vec:Float32Array, model, dim }
const vectorsBySender = new Map(); // sender -> [refs] (keeps brute-force search cheap, one contact at a time)
function indexVec(rec) {
  vectors.push(rec);
  let arr = vectorsBySender.get(rec.sender);
  if (!arr) {
    arr = [];
    vectorsBySender.set(rec.sender, arr);
  }
  arr.push(rec);
}
function storeEmbedding(sender, role, text, vec, ts) {
  const rec = { id: `${sender}:${ts}:${role}`, sender, role, text, ts, vec, model: EMBED_MODEL, dim: EMBED_DIM };
  try {
    // serialize Float32Array as a plain rounded array (smaller, JSON-safe)
    const line = JSON.stringify({
      id: rec.id, sender, role, text, ts, model: EMBED_MODEL, dim: EMBED_DIM,
      vec: Array.from(vec, (x) => Math.round(x * 1e6) / 1e6),
    });
    fs.appendFileSync(EMBEDDINGS_FILE, line + '\n');
  } catch (e) {
    log('embed store fail', e.message);
  }
  indexVec(rec);
}
// fire-and-forget: NEVER awaited, NEVER blocks or breaks the reply path
function embedAndStore(sender, role, text) {
  if (!EMBED_ENABLED || !text) return;
  embed(text).then((vec) => { if (vec) storeEmbedding(sender, role, text, vec, Date.now()); }).catch(() => {});
}
function loadEmbeddings() {
  let loaded = 0, skipped = 0;
  try {
    if (!fs.existsSync(EMBEDDINGS_FILE)) return log('no embeddings file yet');
    for (const line of fs.readFileSync(EMBEDDINGS_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { skipped++; continue; } // tolerate a torn trailing line
      if (r.model !== EMBED_MODEL || r.dim !== EMBED_DIM || !Array.isArray(r.vec) || r.vec.length !== EMBED_DIM) {
        skipped++; continue; // model/dim change -> ignore old vectors instead of corrupting cosine
      }
      indexVec({ id: r.id, sender: r.sender, role: r.role, text: r.text, ts: r.ts, vec: Float32Array.from(r.vec), model: r.model, dim: r.dim });
      loaded++;
    }
    log('embeddings loaded:', loaded, 'skipped:', skipped);
  } catch (e) {
    log('embeddings load fail', e.message);
  }
}
// retrieve top-K semantically-similar PAST messages for this sender; fail-open -> []
async function retrieve(sender, queryText, k = RETRIEVE_K, exclude = new Set()) {
  if (!EMBED_ENABLED) return [];
  try {
    const cands = vectorsBySender.get(sender);
    if (!cands || !cands.length) return []; // first contact -> no query embed call at all
    const qv = await embed(queryText);
    if (!qv) return [];
    const now = Date.now();
    const scored = [];
    for (const c of cands) {
      if (!RETRIEVE_ROLES.has(c.role)) continue; // default 'user' only: bot won't retrieve/echo its own past wording
      if (exclude.has(c.text)) continue; // don't re-inject what's already in the recent window
      const sim = dot(qv, c.vec);
      if (sim < RETRIEVE_MIN_SCORE) continue;
      // tiny recency tiebreak (<=0.02), never overrides a clearly better semantic match
      const ageDays = (now - (c.ts || now)) / (1000 * 60 * 60 * 24);
      const score = sim + Math.max(0, 0.02 * (1 - ageDays / 30));
      scored.push({ text: c.text, role: c.role, ts: c.ts, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  } catch (e) {
    log('retrieve fail', e.message);
    return [];
  }
}
// one-time, idempotent backfill so memory isn't empty on first deploy
async function maybeBackfill() {
  try {
    if (!EMBED_ENABLED) return;
    if (fs.existsSync(EMBEDDINGS_FILE) && fs.statSync(EMBEDDINGS_FILE).size > 0) return log('backfill skipped (embeddings exist)');
    const items = [];
    if (fs.existsSync(CHATLOG_FILE)) {
      for (const line of fs.readFileSync(CHATLOG_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r.contact || !r.text) continue;
        items.push({ sender: onlyDigits(r.contact), role: r.dir === 'in' ? 'user' : 'model', text: r.text, ts: Date.parse(r.t) || Date.now() });
      }
    } else if (fs.existsSync(HISTORY_FILE)) {
      try {
        const obj = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        for (const [sender, h] of Object.entries(obj)) {
          for (const t of h.turns || []) items.push({ sender, role: t.role, text: t.text, ts: h.updated || Date.now() });
        }
      } catch {}
    }
    if (!items.length) return log('backfill: nothing to embed');
    log('backfill: embedding', items.length, 'messages...');
    let done = 0;
    const seen = new Set();
    for (const it of items) {
      const key = it.sender + '|' + it.text;
      if (!it.sender || !it.text || seen.has(key)) continue;
      seen.add(key);
      const vec = await embed(it.text);
      if (vec) {
        storeEmbedding(it.sender, it.role, it.text, vec, it.ts);
        done++;
        if (done % 50 === 0) log('backfill progress', done);
      }
      await sleep(rand(200, 500));
    }
    log('backfill done:', done, 'embedded');
  } catch (e) {
    log('backfill fail', e.message);
  }
}

// ---- human-like timing: serial queue, never instant, never two at once ----
// time-of-day awareness (persona timezone) so the bot greets/asks appropriately and re-opens cold chats
function timeContext() {
  let h = 12;
  try {
    h = Number(new Intl.DateTimeFormat('en-US', { timeZone: persona.timezone, hour: 'numeric', hour12: false }).format(new Date()));
  } catch {}
  if (h === 24) h = 0;
  return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'late at night';
}
const humanDelay = (len) => Math.round(rand(1200, 2800) + Math.min(len * rand(45, 75), 9000));
const queue = [];
let working = false;
async function worker() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    if (isPaused()) { log('skip send (paused)', mask(job.sender)); continue; } // paused after this was queued
    try {
      const prior = histories.get(job.sender);
      const wasFresh = !prior || !prior.turns.length || Date.now() - prior.updated > HISTORY_TTL;
      remember(job.sender, 'user', job.text);
      embedAndStore(job.sender, 'user', job.text); // fire-and-forget long-term write
      let turns = history(job.sender).turns.slice();
      while (turns.length && turns[0].role === 'model') turns.shift(); // Gemini wants to start on a user turn
      const contents = turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
      // Layer 2: pull relevant older messages and add them as extra system context (fail-open)
      let extraSystem = '';
      let hits = [];
      try {
        const exclude = new Set(turns.map((t) => t.text));
        hits = await retrieve(job.sender, job.text, RETRIEVE_K, exclude);
        if (hits.length) {
          extraSystem =
            'Earlier things this person told you (FACTS/CONTEXT to recall what was discussed). ' +
            'Do NOT imitate their phrasing, slang, or tone; your own voice is defined above:\n' +
            hits.map((h) => `- ${h.role === 'user' ? 'them' : 'you'}: ${h.text.slice(0, 300)}`).join('\n');
          log('RAG', mask(job.sender), `${hits.length} hit(s)`, hits.map((h) => h.score.toFixed(2)).join(','));
        }
      } catch (e) {
        log('RAG skip', e.message);
      }
      // time-of-day awareness + graceful restart when the thread has gone cold
      const tod = timeContext();
      let timeHint = `for context, right now it is ${tod} where they are.`;
      if (wasFresh && !hits.length) {
        timeHint +=
          ` you have not talked in a while and there is no recent thread, so re-open the chat naturally and warmly` +
          ` (for example ask how their day is going or what they are up to, fitting the time of day) instead of` +
          ` replying as if you were mid conversation.`;
      }
      extraSystem = extraSystem ? extraSystem + '\n\n' + timeHint : timeHint;
      const reply = await askGemini(contents, extraSystem);
      if (reply) {
        remember(job.sender, 'model', reply);
        embedAndStore(job.sender, 'model', reply); // fire-and-forget long-term write
        const wait = humanDelay(reply.length);
        log('...', mask(job.sender), `waiting ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
        const outText = job.sender === SELF_NUMBER ? reply + ' --AI' : reply; // tag self-chat test replies
        await sendWhatsApp(job.chatId, outText);
        log('OUT', mask(job.sender), JSON.stringify(reply.slice(0, 80)));
        chatlog('out', job.sender, reply);
      }
    } catch (e) {
      log('ERROR', e.message);
    }
    await sleep(rand(900, 2200)); // gap before next chat
  }
  working = false;
}

// ---- debounce: people send several bubbles in a row; wait for them to finish, reply once ----
const DEBOUNCE_MS = 12000; // ~12s of silence = they're done typing (people send several bubbles, spaced out)
const pending = new Map();

function handle(payload) {
  const m = (payload && payload.data) || {};
  if (!m.from || m.fromMe || m.isGroup) return; // ignore our own sends, groups, junk
  let sender = onlyDigits(m.from);
  if (!allowSet().has(sender)) {
    // m.from may be a LID (WhatsApp privacy id) rather than the phone number; resolve via contacts.
    const real = _contacts.lidToReal.get(sender);
    if (real && allowSet().has(real)) {
      log('resolved LID', mask(m.from), '->', mask(real));
      sender = real; // identity/memory key = real number; reply still goes to m.chatId (the @lid)
    } else {
      return log('skip (not allow-listed)', mask(m.from));
    }
  }
  const text = (m.body || '').trim();
  if (!text) return;
  // self-chat command console: owner-only, '/'-prefixed (or bare help/menu). Handled before the pause gate so /resume always works.
  if (sender === SELF_NUMBER && SELF_NUMBER && (text.startsWith('/') || text.toLowerCase() === 'help' || text.toLowerCase() === 'menu')) {
    handleCommand(text, m.chatId);
    return;
  }
  log('IN ', mask(m.from), JSON.stringify(text.slice(0, 80)));
  chatlog('in', sender, text);
  if (isPaused()) return log('skip (paused)', mask(sender));
  let p = pending.get(sender);
  if (!p) {
    p = { chatId: m.chatId, from: m.from, msgs: [], timer: null };
    pending.set(sender, p);
  }
  p.chatId = m.chatId;
  p.from = m.from;
  p.msgs.push(text);
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pending.delete(sender);
    const combined = p.msgs.join('\n'); // all their bubbles become one turn
    log('settled', mask(sender), `${p.msgs.length} msg(s) -> reply`);
    queue.push({ chatId: p.chatId, text: combined, from: p.from, sender });
    worker();
  }, DEBOUNCE_MS);
}

http
  .createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          ok: true,
          allowCount: allowSet().size,
          allow: [...allowSet()].map((n) => '...' + n.slice(-4)),
          model: GEMINI_MODEL,
          keys: keys.length,
          keysAvailable: keys.filter((k) => k.availableAt <= Date.now()).length,
          threads: histories.size,
          lidMappings: _contacts.lidToReal.size,
          embedEnabled: EMBED_ENABLED,
          embedModel: EMBED_MODEL,
          embedDim: EMBED_DIM,
          embedKeysAvailable: keys.filter((k) => k.embedAvailableAt <= Date.now()).length,
          vectors: vectors.length,
          persona: persona.name,
          personaExamples: persona.examples.length,
          timezone: persona.timezone,
          retrieveRoles: [...RETRIEVE_ROLES],
          paused: isPaused(),
        }),
      );
    }
    if (req.method === 'GET' && req.url.startsWith('/chats')) {
      // last 100 logged messages (both directions), newest last
      let out = [];
      try {
        out = fs.readFileSync(CHATLOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-100);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('[' + out.join(',') + ']');
    }
    if (req.method === 'GET' && req.url.startsWith('/memory')) {
      // inspect what RAG would retrieve: /memory?sender=<digits>&q=<text>
      const u = new URL(req.url, 'http://x');
      const sender = onlyDigits(u.searchParams.get('sender') || '');
      const q = u.searchParams.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!sender || !q) return res.end(JSON.stringify({ error: 'need ?sender=<digits>&q=<text>' }));
      try {
        const hits = await retrieve(sender, q, RETRIEVE_K, new Set());
        return res.end(
          JSON.stringify({
            sender: mask(sender),
            stored: (vectorsBySender.get(sender) || []).length,
            count: hits.length,
            hits: hits.map((h) => ({ role: h.role, ts: h.ts, score: Number(h.score.toFixed(3)), text: h.text })),
          }),
        );
      } catch (e) {
        return res.end(JSON.stringify({ error: String(e.message) }));
      }
    }
    if (req.method === 'POST' && req.url === '/openwa-webhook') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true })); // ack fast so OpenWA doesn't retry
        let payload;
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          return log('ERROR bad JSON');
        }
        try {
          handle(payload);
        } catch (e) {
          log('ERROR', e.message);
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/outbound') {
      // { to, text } -> send via OpenWA AND record it as a 'model' turn so the
      // bot remembers it opened the conversation (keeps the next reply in context).
      // `to` may be a phone number, a 15-digit LID, or a full chatId (...@c.us / ...@lid).
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        try {
          const { to, text } = JSON.parse(body || '{}');
          if (!to || !text) throw new Error('need {to, text}');
          // Pick the address that actually delivers: a LID (or a number that has one) -> @lid, else @c.us.
          let chatId, sender;
          if (String(to).includes('@')) {
            chatId = String(to);
            sender = _contacts.lidToReal.get(onlyDigits(to)) || onlyDigits(to);
          } else {
            const d = onlyDigits(to);
            if (!d) throw new Error('need {to, text}');
            if (_contacts.lids.has(d)) {
              chatId = d + '@lid';
              sender = _contacts.lidToReal.get(d) || d;
            } else if (_contacts.realToLid.has(d)) {
              chatId = _contacts.realToLid.get(d) + '@lid';
              sender = d;
            } else {
              chatId = d + '@c.us';
              sender = d;
            }
          }
          remember(sender, 'model', text);
          embedAndStore(sender, 'model', text); // fire-and-forget long-term write
          await sendWhatsApp(chatId, text);
          chatlog('out', sender, text);
          log('OUT(seed)', mask(sender), '->', chatId, JSON.stringify(text.slice(0, 80)));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          log('ERROR outbound', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })
  .listen(Number(PORT), () => {
    log(`bridge on :${PORT} allow=${allowSet().size} keys=${keys.length} model=${GEMINI_MODEL} embed=${EMBED_ENABLED ? EMBED_MODEL : 'off'} persona=${persona.name} tz=${persona.timezone} examples=${persona.examples.length}`);
    loadEmbeddings();
    refreshContacts();
    setInterval(refreshContacts, 60000).unref();
    maybeBackfill();
  });
