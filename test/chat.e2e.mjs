/**
 * End-to-end check of the chat path, against a stub that speaks the Anthropic
 * streaming wire format. No API key and no spend: this proves our own
 * plumbing — the SSE relay, the transcript, the retry, the failure frame.
 *
 * Run: node test/chat.e2e.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_PORT = 3199;
const PORT = 3125;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/* ------------------------- a stub Anthropic API -------------------------- */

/** 'ok' | 'reject-effort' | 'fail' — what the next upstream call should do. */
let mode = 'ok';
const seen = [];

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  frame('message_start', {
    type: 'message_start',
    message: { id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub',
               content: [], stop_reason: null, stop_sequence: null,
               usage: { input_tokens: 1, output_tokens: 1 } },
  });
  frame('content_block_start', { type: 'content_block_start', index: 0,
                                 content_block: { type: 'text', text: '' } });
  for (const text of chunks) {
    frame('content_block_delta', { type: 'content_block_delta', index: 0,
                                   delta: { type: 'text_delta', text } });
  }
  frame('content_block_stop', { type: 'content_block_stop', index: 0 });
  frame('message_delta', { type: 'message_delta',
                           delta: { stop_reason: 'end_turn', stop_sequence: null },
                           usage: { output_tokens: 4 } });
  frame('message_stop', { type: 'message_stop' });
  res.end();
}

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    seen.push({ url: req.url, effort: parsed.output_config?.effort ?? null, body: parsed });

    if (mode === 'fail') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
    }
    if (mode === 'reject-effort' && parsed.output_config) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config not supported' } }));
    }
    sse(res, ['Right, ', 'the kettle is on. ', 'Anything else?']);
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

/* -------------------------- the server under test ------------------------ */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkback-chat-'));
// Pre-seed a signed-in session by reusing the server's own session format.
const { mintSession, randomB64u } = await import(path.join(ROOT, 'lib/webauthn.js'));
const hmacKey = randomB64u(32);
const credId = 'test-credential';
fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({
  hmacKey, claimed: true, challenges: [], turns: [],
  credentials: [{ credId, publicKey: '', alg: -7, signCount: 0,
                  origin: `http://127.0.0.1:${PORT}`, rpId: '127.0.0.1', label: 'Seed' }],
}));
const cookie = 'talkback=' + (await mintSession(hmacKey, credId, 3600_000));

const server = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TALKBACK_DATA_DIR: dir,
         TALKBACK_HMAC_KEY: hmacKey,
         ANTHROPIC_API_KEY: 'sk-ant-stub', ANTHROPIC_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
         ANTHROPIC_LOG: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));

for (let i = 0; i < 80; i++) {
  try { await fetch(BASE + '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

/** Reads an SSE response to the end and returns the parsed frames. */
async function chat(text, history) {
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text, history }),
  });
  if (res.status !== 200) return { status: res.status, frames: [] };
  const body = await res.text();
  const frames = body
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)));
  return { status: res.status, frames };
}

try {
  /* ------------------------------ happy path ---------------------------- */
  let r = await chat('Put the kettle on');
  const deltas = r.frames.filter((f) => f.delta !== undefined).map((f) => f.delta);
  const done = r.frames.find((f) => f.done);
  check('the reply streams as more than one frame', deltas.length === 3, `got ${deltas.length}`);
  check('the frames reassemble into the reply',
    deltas.join('') === 'Right, the kettle is on. Anything else?', deltas.join(''));
  check('a done frame closes the turn', Boolean(done) && done.reply === deltas.join(''),
    JSON.stringify(done));
  check('the request asked for low effort', seen.at(-1)?.effort === 'low',
    JSON.stringify(seen.at(-1)?.effort));

  r = await fetch(BASE + '/api/transcript', { headers: { Cookie: cookie } });
  const { turns } = await r.json();
  check('both sides of the turn are in the transcript',
    turns.length === 2 && turns[0].role === 'user' && turns[1].role === 'assistant',
    JSON.stringify(turns.map((t) => t.role)));

  /* ------------------------------- history ------------------------------- */
  seen.length = 0;
  await chat('And a biscuit', [
    { role: 'user', text: 'Put the kettle on' },
    { role: 'assistant', text: 'Right, the kettle is on.' },
  ]);
  const sent = seen.at(-1).body.messages;
  check('history is forwarded in order and roles alternate',
    sent.length === 3 && sent[0].role === 'user' && sent[1].role === 'assistant' &&
      sent[2].role === 'user' && sent[2].content === 'And a biscuit',
    JSON.stringify(sent.map((m) => m.role)));
  check('the spoken brief is sent as a system prompt',
    typeof seen.at(-1).body.system === 'string' && /voice line/.test(seen.at(-1).body.system));

  /* -------------------- degrade when effort is refused ------------------- */
  mode = 'reject-effort';
  seen.length = 0;
  r = await chat('Try again');
  const text2 = r.frames.filter((f) => f.delta !== undefined).map((f) => f.delta).join('');
  check('a refused effort setting retries plainly and still answers',
    text2 === 'Right, the kettle is on. Anything else?', text2);
  check('the retry dropped output_config',
    seen.length === 2 && seen[0].effort === 'low' && seen[1].effort === null,
    JSON.stringify(seen.map((x) => x.effort)));

  /* ------------------------------ hard failure --------------------------- */
  mode = 'fail';
  r = await chat('Will this hang?');
  const err = r.frames.find((f) => f.error);
  check('an upstream failure ends the stream with an error frame', Boolean(err),
    JSON.stringify(r.frames));
  check('the rate-limit message is the readable one', /Rate limited/.test(err?.error || ''),
    err?.error);

  /* ------------------------------- guards -------------------------------- */
  mode = 'ok';
  r = await chat('   ');
  check('empty speech is refused before spending a call', r.status === 400, `status ${r.status}`);

  const anon = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  });
  check('chat without a session is refused', anon.status === 401, `status ${anon.status}`);
} catch (e) {
  failed++;
  console.log(`  FAIL harness — ${e?.message || e}`);
} finally {
  server.kill();
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
