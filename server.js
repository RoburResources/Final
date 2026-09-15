import express from 'express';
import cookieParser from 'cookie-parser';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fromB64u,
  mintSession,
  parseClientData,
  randomB64u,
  readSession,
  toB64u,
  verifyAssertion,
} from './lib/webauthn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Overridable so the store can live on a mounted disk rather than next to the
// code, which matters on hosts whose app directory is wiped on redeploy.
const DATA = process.env.TALKBACK_DATA_DIR || path.join(here, 'data');
const STORE = path.join(DATA, 'store.json');

/**
 * Optional. When set, claiming an unclaimed deployment also requires this
 * code. Without it, claiming is trust-on-first-use: whoever reaches the URL
 * first owns it. With it, a wiped store cannot be claimed by a passer-by.
 */
const CLAIM_CODE = (process.env.TALKBACK_CLAIM_CODE || '').trim();

function codeAccepted(given) {
  if (!CLAIM_CODE) return true;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(CLAIM_CODE, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const COOKIE = 'talkback';

/* --------------------------------- store -------------------------------- */

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return { hmacKey: randomB64u(32), claimed: false, credentials: [], challenges: [], turns: [] };
  }
}

let db = load();

// A key held in the environment survives a wiped disk, so sessions outlive a
// redeploy. Without one we generate and persist a key on first run.
if (process.env.TALKBACK_HMAC_KEY) db.hmacKey = process.env.TALKBACK_HMAC_KEY.trim();

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2));
}
save();

function issueChallenge(purpose) {
  const challenge = randomB64u(32);
  const now = Date.now();
  db.challenges = db.challenges.filter((c) => c.expiresAt > now);
  db.challenges.push({ challenge, purpose, expiresAt: now + CHALLENGE_TTL_MS });
  save();
  return challenge;
}

/** Consumes the challenge, so a captured assertion cannot be replayed. */
function consumeChallenge(challenge, purpose) {
  const now = Date.now();
  const hit = db.challenges.find(
    (c) => c.challenge === challenge && c.purpose === purpose && c.expiresAt > now,
  );
  db.challenges = db.challenges.filter((c) => c.challenge !== challenge && c.expiresAt > now);
  save();
  return Boolean(hit);
}

/* --------------------------------- app ---------------------------------- */

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Replit terminates TLS in front of us; trust it so secure cookies work.
app.set('trust proxy', 1);

function originOf(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}`;
}

async function signedIn(req) {
  const credId = await readSession(db.hmacKey, req.cookies?.[COOKIE]);
  return credId && db.credentials.some((c) => c.credId === credId) ? credId : null;
}

function setSession(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    // Secure on a real deployment; off over plain http so `npm run dev` on
    // localhost still works. Browsers treat localhost as a secure context, so
    // WebAuthn is happy either way.
    secure: originOf(req).startsWith('https://'),
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  });
}

app.get('/api/state', async (req, res) => {
  res.json({
    claimed: db.claimed,
    signedIn: Boolean(await signedIn(req)),
    devices: db.credentials.length,
    needsCode: Boolean(CLAIM_CODE) && !db.claimed,
  });
});

app.post('/api/webauthn/options', async (req, res) => {
  const purpose = req.body?.purpose === 'enrol' ? 'enrol' : 'verify';

  // Open while unclaimed; afterwards only an already-unlocked owner may add a device.
  if (purpose === 'enrol' && db.claimed && !(await signedIn(req))) {
    return res.status(403).json({ error: 'Already claimed by another device' });
  }
  if (purpose === 'enrol' && !db.claimed && !codeAccepted(req.body?.code)) {
    return res.status(403).json({ error: 'Wrong setup code' });
  }
  if (purpose === 'verify' && !db.claimed) {
    return res.status(404).json({ error: 'Nothing enrolled yet' });
  }

  res.json({
    challenge: issueChallenge(purpose),
    credentials: db.credentials.map((c) => c.credId),
    userHandle: toB64u(Buffer.from('talkback-owner', 'utf8')),
  });
});

app.post('/api/webauthn/enrol', async (req, res) => {
  if (db.claimed && !(await signedIn(req))) {
    return res.status(403).json({ error: 'Already claimed by another device' });
  }
  if (!db.claimed && !codeAccepted(req.body?.code)) {
    return res.status(403).json({ error: 'Wrong setup code' });
  }

  const { credId, publicKey, alg, clientDataJSON, label } = req.body || {};
  if (!credId || !publicKey || !clientDataJSON || (alg !== -7 && alg !== -257)) {
    return res.status(400).json({ error: 'Incomplete enrolment' });
  }

  let data;
  try {
    data = parseClientData(clientDataJSON);
  } catch {
    return res.status(400).json({ error: 'Malformed client data' });
  }
  if (data.type !== 'webauthn.create') return res.status(400).json({ error: 'Wrong ceremony' });
  if (!consumeChallenge(data.challenge, 'enrol')) {
    return res.status(400).json({ error: 'Challenge expired — try again' });
  }
  // The origin must be this server's own, not one the caller invents.
  if (data.origin !== originOf(req)) return res.status(400).json({ error: 'Origin mismatch' });
  if (db.credentials.some((c) => c.credId === credId)) {
    return res.status(400).json({ error: 'This device is already enrolled' });
  }

  db.credentials.push({
    credId,
    publicKey,
    alg,
    signCount: 0,
    origin: data.origin,
    rpId: new URL(data.origin).hostname,
    label: String(label || 'This device').slice(0, 60),
    enrolledAt: new Date().toISOString(),
  });
  db.claimed = true;
  save();

  setSession(req, res, await mintSession(db.hmacKey, credId, SESSION_TTL_MS));
  res.json({ ok: true });
});

app.post('/api/webauthn/verify', async (req, res) => {
  const { credId, authenticatorData, clientDataJSON, signature } = req.body || {};
  if (!credId || !authenticatorData || !clientDataJSON || !signature) {
    return res.status(400).json({ error: 'Incomplete assertion' });
  }

  const credential = db.credentials.find((c) => c.credId === credId);
  if (!credential) return res.status(401).json({ error: 'Unknown device' });

  const result = await verifyAssertion({
    credential,
    authenticatorData,
    clientDataJSON,
    signature,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (!consumeChallenge(result.challenge, 'verify')) {
    return res.status(400).json({ error: 'Challenge expired — try again' });
  }

  credential.signCount = result.signCount;
  credential.lastUsed = new Date().toISOString();
  save();

  setSession(req, res, await mintSession(db.hmacKey, credId, SESSION_TTL_MS));
  res.json({ ok: true });
});

app.post('/api/lock', (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

/* --------------------------------- brain -------------------------------- */

const BRIEF = [
  'You are Claude, talking with Michael over a live voice line called Talkback.',
  'He speaks into a microphone; your reply is read aloud by a speech synthesiser and he hears it.',
  'Because this is speech, not writing:',
  '- Keep replies short. Two or three sentences is usually right. Never more than about 90 words unless he asks you to go long.',
  '- Write plain spoken English. No markdown, no bullet points, no headings, no code blocks, no emoji, no stage directions.',
  '- Expand anything that would be read out badly: say "about forty per cent", not "~40%".',
  '- Speech recognition makes mistakes. If a word looks garbled, guess from context and carry on; ask only if the meaning really turns on it.',
  '- Answer first, then offer the follow-up. Do not open with pleasantries every turn.',
  '- Never open by describing yourself or how you will behave. Answer what he actually said.',
].join('\n');

const MODEL = process.env.TALKBACK_MODEL || 'claude-opus-5';
const anthropic = new Anthropic();

app.get('/api/transcript', async (req, res) => {
  if (!(await signedIn(req))) return res.status(401).json({ error: 'Locked' });
  res.json({ turns: db.turns.slice(-200) });
});

app.post('/api/transcript/clear', async (req, res) => {
  if (!(await signedIn(req))) return res.status(401).json({ error: 'Locked' });
  const n = db.turns.length;
  db.turns = [];
  save();
  res.json({ cleared: n });
});

app.post('/api/chat', async (req, res) => {
  if (!(await signedIn(req))) return res.status(401).json({ error: 'Locked' });

  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Nothing to say' });

  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .slice(-20)
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: String(t.text).slice(0, 4000),
    }));

  // Streamed so the browser can start speaking the first sentence while the
  // rest is still being written — that is what makes it feel like a line.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const request = {
    model: MODEL,
    max_tokens: 500,
    system: BRIEF,
    messages: [...history, { role: 'user', content: text.slice(0, 4000) }],
  };

  let full = '';
  const run = async (tuned) => {
    // `output_config.effort` lives on the beta surface. Low effort keeps a
    // spoken reply snappy — this is conversation, not analysis. If the account
    // or model will not take it, `tuned: false` is the plain stable call.
    const stream = tuned
      ? anthropic.beta.messages.stream({ ...request, output_config: { effort: 'low' } })
      : anthropic.messages.stream(request);
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        full += event.delta.text;
        res.write(`data: ${JSON.stringify({ delta: event.delta.text })}\n\n`);
      }
    }
  };

  try {
    try {
      await run(true);
    } catch (err) {
      // Nothing had streamed yet, so retrying cannot duplicate any text.
      if ((err?.status === 400 || err?.status === 404) && !full) {
        console.warn('effort unsupported here, retrying plainly:', err?.message);
        await run(false);
      } else {
        throw err;
      }
    }

    const reply = full.trim();
    if (reply) {
      const at = new Date().toISOString();
      db.turns.push({ role: 'user', text: text.slice(0, 4000), at });
      db.turns.push({ role: 'assistant', text: reply.slice(0, 4000), at });
      if (db.turns.length > 400) db.turns = db.turns.slice(-400);
      save();
    }
    res.write(`data: ${JSON.stringify({ done: true, reply })}\n\n`);
  } catch (err) {
    console.error('chat failed:', err?.message || err);
    const message =
      err?.status === 401
        ? 'The server has no valid ANTHROPIC_API_KEY.'
        : err?.status === 429
          ? 'Rate limited. Give it a moment.'
          : 'Claude could not answer that one.';
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  }
  res.end();
});

/* -------------------------------- static -------------------------------- */

app.use(express.static(path.join(here, 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(here, 'dist', 'index.html')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Talkback listening on ${port}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY is not set — the voice line will not be able to answer.');
  }
  if (!db.claimed && !CLAIM_CODE) {
    console.warn(
      'Unclaimed and no TALKBACK_CLAIM_CODE set — whoever opens the URL first can claim it. ' +
        'Enrol now, or set a claim code and restart.',
    );
  }
});
