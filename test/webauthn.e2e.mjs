/**
 * End-to-end check of the login path against a running server, using a
 * synthetic authenticator built on WebCrypto.
 *
 * This exercises the real ceremony: a server-issued challenge, clientDataJSON,
 * authenticator data with the right rpIdHash and flags, and a DER-encoded
 * ES256 signature — exactly the shapes a real Face ID authenticator sends.
 *
 * Run: node test/webauthn.e2e.mjs   (starts its own server on a spare port)
 */
import { spawn } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE.replace('127.0.0.1', '127.0.0.1');
const RP_ID = '127.0.0.1';
const CODE = 'open-sesame';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ------------------------------ tiny helpers ----------------------------- */

const toB64u = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const sha256 = async (d) => new Uint8Array(await crypto.subtle.digest('SHA-256', d));

/** WebCrypto signs P1363 (raw r||s); authenticators send DER. Convert. */
function rawToDer(raw) {
  const trim = (v) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    const out = v.slice(i);
    return out[0] & 0x80 ? new Uint8Array([0, ...out]) : out;
  };
  const r = trim(raw.slice(0, 32));
  const s = trim(raw.slice(32));
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
  return new Uint8Array([0x30, body.length, ...body]);
}

function clientData(type, challenge, origin = ORIGIN) {
  return toB64u(utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

async function authData(rpId, flags, signCount) {
  const hash = await sha256(utf8(rpId));
  const counter = new Uint8Array([
    (signCount >>> 24) & 0xff,
    (signCount >>> 16) & 0xff,
    (signCount >>> 8) & 0xff,
    signCount & 0xff,
  ]);
  return new Uint8Array([...hash, flags, ...counter]);
}

/* ------------------------------ http client ------------------------------ */

let cookie = '';
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 120) };
  }
  return { status: res.status, data };
}

/* --------------------------------- run ----------------------------------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkback-test-'));
const server = spawn('node', ['server.js'], {
  cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    TALKBACK_DATA_DIR: dir,
    TALKBACK_CLAIM_CODE: CODE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + '/api/state');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

try {
  if (!(await waitForServer())) throw new Error('server did not start');

  /* --------------------------- unclaimed state --------------------------- */
  let r = await api('GET', '/api/state');
  check('state: unclaimed, locked, code required',
    r.data.claimed === false && r.data.signedIn === false && r.data.needsCode === true,
    JSON.stringify(r.data));

  r = await api('POST', '/api/chat', { text: 'hello' });
  check('chat is refused while locked', r.status === 401, `status ${r.status}`);

  r = await api('GET', '/api/transcript');
  check('transcript is refused while locked', r.status === 401, `status ${r.status}`);

  /* ----------------------------- claim code ------------------------------ */
  r = await api('POST', '/api/webauthn/options', { purpose: 'enrol', code: 'wrong' });
  check('wrong setup code is refused', r.status === 403, `status ${r.status}`);

  r = await api('POST', '/api/webauthn/options', { purpose: 'verify' });
  check('sign-in refused before anything is enrolled', r.status === 404, `status ${r.status}`);

  /* ------------------------------- enrol --------------------------------- */
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const credId = toB64u(crypto.getRandomValues(new Uint8Array(32)));

  r = await api('POST', '/api/webauthn/options', { purpose: 'enrol', code: CODE });
  check('enrol options issued with the right code', r.status === 200 && Boolean(r.data.challenge),
    JSON.stringify(r.data));
  const enrolChallenge = r.data.challenge;

  r = await api('POST', '/api/webauthn/enrol', {
    credId,
    publicKey: toB64u(spki),
    alg: -7,
    clientDataJSON: clientData('webauthn.create', enrolChallenge),
    label: 'Test device',
    code: CODE,
  });
  check('enrolment accepted', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  check('enrolment signed the device in', cookie.startsWith('talkback='), cookie);

  r = await api('GET', '/api/state');
  check('state: claimed and signed in', r.data.claimed === true && r.data.signedIn === true,
    JSON.stringify(r.data));

  /* --------------------- a second claimant is locked out ------------------- */
  const outsider = cookie;
  cookie = '';
  r = await api('POST', '/api/webauthn/options', { purpose: 'enrol', code: CODE });
  check('a second device cannot claim an owned app', r.status === 403, `status ${r.status}`);
  cookie = outsider;

  /* ------------------------------- sign in -------------------------------- */
  async function assertion({ flags = 0x05, signCount = 1, rpId = RP_ID, origin = ORIGIN,
                             challenge, type = 'webauthn.get', badSig = false } = {}) {
    const cdj = clientData(type, challenge, origin);
    const ad = await authData(rpId, flags, signCount);
    const signed = new Uint8Array([...ad, ...(await sha256(Buffer.from(
      cdj.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (cdj.length % 4)) % 4), 'base64')))]);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed),
    );
    if (badSig) raw[0] ^= 0xff;
    return {
      credId,
      authenticatorData: toB64u(ad),
      clientDataJSON: cdj,
      signature: toB64u(rawToDer(raw)),
    };
  }

  const freshChallenge = async () => {
    cookie = '';
    const o = await api('POST', '/api/webauthn/options', { purpose: 'verify' });
    return o.data.challenge;
  };

  // A real, complete unlock.
  let ch = await freshChallenge();
  r = await api('POST', '/api/webauthn/verify', await assertion({ challenge: ch, signCount: 1 }));
  check('a valid biometric assertion unlocks', r.status === 200 && r.data.ok === true,
    JSON.stringify(r.data));

  r = await api('GET', '/api/transcript');
  check('transcript readable once unlocked', r.status === 200 && Array.isArray(r.data.turns),
    JSON.stringify(r.data).slice(0, 80));

  // Replay of a spent challenge.
  const spent = await assertion({ challenge: ch, signCount: 2 });
  cookie = '';
  r = await api('POST', '/api/webauthn/verify', spent);
  check('a replayed challenge is refused', r.status === 400, `status ${r.status}`);

  // No user verification: a tap, not a face.
  ch = await freshChallenge();
  r = await api('POST', '/api/webauthn/verify',
    await assertion({ challenge: ch, flags: 0x01, signCount: 3 }));
  check('presence without biometric is refused', r.status === 401 &&
    /[Bb]iometric/.test(r.data.error || ''), JSON.stringify(r.data));

  // Wrong relying party.
  ch = await freshChallenge();
  r = await api('POST', '/api/webauthn/verify',
    await assertion({ challenge: ch, rpId: 'evil.example', signCount: 3 }));
  check('a mismatched relying party is refused', r.status === 401, JSON.stringify(r.data));

  // Wrong origin.
  ch = await freshChallenge();
  r = await api('POST', '/api/webauthn/verify',
    await assertion({ challenge: ch, origin: 'https://evil.example', signCount: 3 }));
  check('a mismatched origin is refused', r.status === 401, JSON.stringify(r.data));

  // Wrong ceremony type.
  ch = await freshChallenge();
  r = await api('POST', '/api/webauthn/verify',
    await assertion({ challenge: ch, type: 'webauthn.create', signCount: 3 }));
  check('the wrong ceremony type is refused', r.status === 400, JSON.stringify(r.data));

  // Tampered signature.
  ch = await freshChallenge();
  r = await api('POST', '/api/webauthn/verify',
    await assertion({ challenge: ch, badSig: true, signCount: 3 }));
  check('a bad signature is refused', r.status === 401, JSON.stringify(r.data));

  // A counter that does not advance — the cloned-authenticator signal.
  ch = await freshChallenge();
  r = await api('POST', '/api/webauthn/verify',
    await assertion({ challenge: ch, signCount: 1 }));
  check('a stale signature counter is refused', r.status === 401 &&
    /[Rr]eplay/.test(r.data.error || ''), JSON.stringify(r.data));

  // And the counter still advances for a genuine later unlock.
  ch = await freshChallenge();
  r = await api('POST', '/api/webauthn/verify', await assertion({ challenge: ch, signCount: 9 }));
  check('a later unlock with an advanced counter works', r.status === 200, JSON.stringify(r.data));

  /* -------------------------------- lock ---------------------------------- */
  await api('POST', '/api/lock');
  cookie = '';
  r = await api('GET', '/api/state');
  check('locking signs the device out', r.data.signedIn === false, JSON.stringify(r.data));

  /* ------------------------------ forgery --------------------------------- */
  cookie = 'talkback=' + toB64u(utf8(JSON.stringify({ sub: credId, exp: Date.now() + 1e7 }))) + '.forged';
  r = await api('GET', '/api/state');
  check('a forged session token is rejected', r.data.signedIn === false, JSON.stringify(r.data));
  cookie = '';
} catch (err) {
  failed++;
  console.log(`  FAIL harness — ${err?.message || err}`);
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
