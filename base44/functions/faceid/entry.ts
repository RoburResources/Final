import { createClientFromRequest } from 'npm:@base44/sdk';

/**
 * Face ID for Talkback — WebAuthn with a platform authenticator.
 *
 * Base44 auth answers "who is this". This answers "is it really them, on this
 * device, right now". The biometric is checked by the operating system and
 * never leaves it: we receive a public key once, then a signature per unlock.
 *
 * Actions: options | enrol | verify | state
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000;

/* ------------------------------ base64url ------------------------------ */

function fromB64u(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomB64u(n: number): string {
  return toB64u(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ------------------------------- WebAuthn ------------------------------ */

type ClientData = { type?: string; challenge?: string; origin?: string };

function parseClientData(clientDataJSON: string): ClientData {
  return JSON.parse(new TextDecoder().decode(fromB64u(clientDataJSON))) as ClientData;
}

/**
 * ECDSA signatures arrive DER-encoded; WebCrypto verifies raw r||s.
 */
function derToRaw(der: Uint8Array): Uint8Array {
  let o = 0;
  if (der[o++] !== 0x30) throw new Error('malformed signature');
  if (der[o] & 0x80) o += 1 + (der[o] & 0x7f);
  else o += 1;

  const readInt = (): Uint8Array => {
    if (der[o++] !== 0x02) throw new Error('malformed signature');
    const len = der[o++];
    let v = der.slice(o, o + len);
    o += len;
    while (v.length > 32 && v[0] === 0x00) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };

  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

async function verifySignature(
  publicKeyB64u: string,
  alg: number,
  authData: Uint8Array,
  clientDataJSON: string,
  signature: Uint8Array,
): Promise<boolean> {
  const signed = new Uint8Array([...authData, ...(await sha256(fromB64u(clientDataJSON)))]);

  if (alg === -7) {
    const key = await crypto.subtle.importKey(
      'spki',
      fromB64u(publicKeyB64u),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), signed);
  }

  if (alg === -257) {
    const key = await crypto.subtle.importKey(
      'spki',
      fromB64u(publicKeyB64u),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  }

  return false;
}

/* -------------------------------- handler ------------------------------ */

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);

  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Expected JSON' }, { status: 400 });
  }
  const action = String(body.action || '');
  const db = base44.asServiceRole.entities;

  // Passkeys are stored per Base44 user, so one person's device can never
  // unlock another's line.
  const mine = async () =>
    (await db.VoicePasskey.filter({ created_by: user.email })) as Array<Record<string, any>>;

  async function issueChallenge(purpose: 'enrol' | 'verify'): Promise<string> {
    const challenge = randomB64u(32);
    await db.VoiceChallenge.create({
      challenge,
      purpose,
      expires_at: Date.now() + CHALLENGE_TTL_MS,
    });
    return challenge;
  }

  /** Consumes the challenge, so a captured assertion cannot be replayed. */
  async function consumeChallenge(challenge: string, purpose: 'enrol' | 'verify'): Promise<boolean> {
    const rows = (await db.VoiceChallenge.filter({ challenge })) as Array<Record<string, any>>;
    const now = Date.now();
    const hit = rows.find((r) => r.purpose === purpose && Number(r.expires_at) > now);
    for (const r of rows) await db.VoiceChallenge.delete(r.id).catch(() => {});
    return Boolean(hit);
  }

  if (action === 'state') {
    const keys = await mine();
    return Response.json({
      enrolled: keys.length > 0,
      devices: keys.map((k) => ({ label: k.label || 'Device', last_used: k.last_used })),
      email: user.email,
    });
  }

  if (action === 'options') {
    const purpose = body.purpose === 'enrol' ? 'enrol' : 'verify';
    const keys = await mine();
    if (purpose === 'verify' && keys.length === 0) {
      return Response.json({ error: 'No device enrolled yet' }, { status: 404 });
    }
    return Response.json({
      challenge: await issueChallenge(purpose),
      credentials: keys.map((k) => k.cred_id),
      userHandle: toB64u(new TextEncoder().encode(String(user.id || user.email))),
      userName: user.email,
      userDisplay: user.full_name || user.email,
    });
  }

  if (action === 'enrol') {
    const credId = String(body.credId || '');
    const publicKey = String(body.publicKey || '');
    const alg = Number(body.alg);
    const clientDataJSON = String(body.clientDataJSON || '');
    if (!credId || !publicKey || !clientDataJSON || (alg !== -7 && alg !== -257)) {
      return Response.json({ error: 'Incomplete enrolment' }, { status: 400 });
    }

    let data: ClientData;
    try {
      data = parseClientData(clientDataJSON);
    } catch {
      return Response.json({ error: 'Malformed client data' }, { status: 400 });
    }
    if (data.type !== 'webauthn.create') {
      return Response.json({ error: 'Wrong ceremony' }, { status: 400 });
    }
    if (!data.origin) return Response.json({ error: 'Missing origin' }, { status: 400 });
    if (!data.challenge || !(await consumeChallenge(data.challenge, 'enrol'))) {
      return Response.json({ error: 'Challenge expired — try again' }, { status: 400 });
    }

    // The origin must be this app's own origin, not one the caller invents.
    const expected = new URL(req.url).origin;
    if (data.origin !== expected) {
      return Response.json({ error: 'Origin mismatch' }, { status: 400 });
    }

    const existing = await mine();
    if (existing.some((k) => k.cred_id === credId)) {
      return Response.json({ error: 'This device is already enrolled' }, { status: 400 });
    }

    await db.VoicePasskey.create({
      cred_id: credId,
      public_key: publicKey,
      alg,
      sign_count: 0,
      origin: data.origin,
      rp_id: new URL(data.origin).hostname,
      label: String(body.label || 'This device').slice(0, 60),
      last_used: new Date().toISOString(),
    });

    return Response.json({ ok: true, unlockedUntil: Date.now() + UNLOCK_TTL_MS });
  }

  if (action === 'verify') {
    const credId = String(body.credId || '');
    const authenticatorData = String(body.authenticatorData || '');
    const clientDataJSON = String(body.clientDataJSON || '');
    const signature = String(body.signature || '');
    if (!credId || !authenticatorData || !clientDataJSON || !signature) {
      return Response.json({ error: 'Incomplete assertion' }, { status: 400 });
    }

    const key = (await mine()).find((k) => k.cred_id === credId);
    if (!key) return Response.json({ error: 'Unknown device' }, { status: 401 });

    let data: ClientData;
    try {
      data = parseClientData(clientDataJSON);
    } catch {
      return Response.json({ error: 'Malformed client data' }, { status: 400 });
    }
    if (data.type !== 'webauthn.get') {
      return Response.json({ error: 'Wrong ceremony' }, { status: 400 });
    }
    if (data.origin !== key.origin) {
      return Response.json({ error: 'Origin mismatch' }, { status: 401 });
    }
    if (!data.challenge || !(await consumeChallenge(data.challenge, 'verify'))) {
      return Response.json({ error: 'Challenge expired — try again' }, { status: 400 });
    }

    const authData = fromB64u(authenticatorData);
    if (authData.length < 37) {
      return Response.json({ error: 'Malformed authenticator data' }, { status: 400 });
    }
    if (!sameBytes(authData.slice(0, 32), await sha256(new TextEncoder().encode(key.rp_id)))) {
      return Response.json({ error: 'Wrong relying party' }, { status: 401 });
    }

    const flags = authData[32];
    if (!(flags & 0x01)) return Response.json({ error: 'No user presence' }, { status: 401 });
    // 0x04 is User Verified. This bit is what makes it Face ID and not a tap.
    if (!(flags & 0x04)) {
      return Response.json({ error: 'Biometric check did not pass' }, { status: 401 });
    }

    const signCount =
      (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];

    const ok = await verifySignature(
      key.public_key,
      Number(key.alg),
      authData,
      clientDataJSON,
      fromB64u(signature),
    );
    if (!ok) return Response.json({ error: 'Signature rejected' }, { status: 401 });

    // A counter that goes backwards suggests a cloned authenticator.
    if (signCount !== 0 && signCount <= Number(key.sign_count || 0)) {
      return Response.json({ error: 'Replay detected' }, { status: 401 });
    }

    await db.VoicePasskey.update(key.id, {
      sign_count: signCount,
      last_used: new Date().toISOString(),
    });

    return Response.json({ ok: true, unlockedUntil: Date.now() + UNLOCK_TTL_MS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 });
}
