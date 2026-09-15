import { webcrypto as crypto } from 'node:crypto';

/**
 * WebAuthn verification — Face ID, Touch ID, Windows Hello, Android biometrics.
 *
 * No library: WebCrypto does everything needed. The biometric is checked by the
 * operating system and never leaves the device; we hold a public key and verify
 * a signature per unlock.
 */

export function fromB64u(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64'));
}

export function toB64u(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function randomB64u(n) {
  return toB64u(crypto.getRandomValues(new Uint8Array(n)));
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function parseClientData(clientDataJSON) {
  return JSON.parse(Buffer.from(fromB64u(clientDataJSON)).toString('utf8'));
}

/**
 * ECDSA signatures arrive DER-encoded; WebCrypto verifies raw r||s.
 */
function derToRaw(der) {
  let o = 0;
  if (der[o++] !== 0x30) throw new Error('malformed signature');
  if (der[o] & 0x80) o += 1 + (der[o] & 0x7f);
  else o += 1;

  const readInt = () => {
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

export async function verifySignature(publicKeyB64u, alg, authData, clientDataJSON, signature) {
  const signed = new Uint8Array([...authData, ...(await sha256(fromB64u(clientDataJSON)))]);

  if (alg === -7) {
    const key = await crypto.subtle.importKey(
      'spki',
      fromB64u(publicKeyB64u),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      derToRaw(signature),
      signed,
    );
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

/**
 * Verify an assertion completely. Returns { ok } or { error, status }.
 */
export async function verifyAssertion({ credential, authenticatorData, clientDataJSON, signature }) {
  let data;
  try {
    data = parseClientData(clientDataJSON);
  } catch {
    return { error: 'Malformed client data', status: 400 };
  }
  if (data.type !== 'webauthn.get') return { error: 'Wrong ceremony', status: 400 };
  if (data.origin !== credential.origin) return { error: 'Origin mismatch', status: 401 };

  const authData = fromB64u(authenticatorData);
  if (authData.length < 37) return { error: 'Malformed authenticator data', status: 400 };

  if (!sameBytes(authData.slice(0, 32), await sha256(Buffer.from(credential.rpId, 'utf8')))) {
    return { error: 'Wrong relying party', status: 401 };
  }

  const flags = authData[32];
  if (!(flags & 0x01)) return { error: 'No user presence', status: 401 };
  // 0x04 is User Verified. This bit is what makes it Face ID rather than a tap.
  if (!(flags & 0x04)) return { error: 'Biometric check did not pass', status: 401 };

  const signCount =
    (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];

  const ok = await verifySignature(
    credential.publicKey,
    credential.alg,
    authData,
    clientDataJSON,
    fromB64u(signature),
  );
  if (!ok) return { error: 'Signature rejected', status: 401 };

  // A counter that goes backwards suggests a cloned authenticator.
  if (signCount !== 0 && signCount <= (credential.signCount || 0)) {
    return { error: 'Replay detected', status: 401 };
  }

  return { ok: true, signCount, challenge: data.challenge };
}

/* ------------------------------- sessions ------------------------------- */

export async function hmac(keyB64u, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    fromB64u(keyB64u),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toB64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, Buffer.from(message, 'utf8'))));
}

export async function mintSession(hmacKey, credId, ttlMs) {
  const payload = toB64u(
    Buffer.from(JSON.stringify({ sub: credId, exp: Date.now() + ttlMs }), 'utf8'),
  );
  return `${payload}.${await hmac(hmacKey, payload)}`;
}

export async function readSession(hmacKey, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.', 2);
  if (!payload || !sig) return null;
  const expected = await hmac(hmacKey, payload);
  if (!sameBytes(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
  try {
    const body = JSON.parse(Buffer.from(fromB64u(payload)).toString('utf8'));
    if (!body.sub || typeof body.exp !== 'number' || body.exp < Date.now()) return null;
    return body.sub;
  } catch {
    return null;
  }
}
