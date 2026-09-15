import { base44 } from '@/api/base44Client';

/**
 * Face ID for Talkback.
 *
 * Base44 auth establishes who you are. This establishes that it is really you,
 * on this device, right now. The face is checked by the operating system and
 * never leaves it — the server only ever sees a public key and a signature.
 */

function fromB64u(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function call(payload) {
  const res = await base44.functions.invoke('faceid', payload);
  return res.data;
}

export async function checkSupport() {
  if (!window.isSecureContext) {
    return { ok: false, reason: 'This page must be on https for Face ID to work.' };
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    return { ok: false, reason: 'This browser does not support passkeys.' };
  }
  try {
    const available = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) {
      return {
        ok: false,
        reason:
          'No built-in biometric was found on this device. Face ID, Touch ID, Windows Hello or an Android screen lock is required.',
      };
    }
  } catch {
    /* an unanswerable probe is not a refusal — let the real call decide */
  }
  return { ok: true };
}

export function readableError(err) {
  const fromServer = err?.response?.data?.error;
  if (fromServer) return fromServer;
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Cancelled, or the biometric check timed out. Try again.';
    case 'InvalidStateError':
      return 'This device is already enrolled — unlock instead.';
    case 'SecurityError':
      return 'The browser refused the request for this domain.';
    case 'AbortError':
      return 'The request was interrupted.';
    case 'NotSupportedError':
      return 'This device cannot create the kind of passkey we need.';
    default:
      return err?.message || 'Something went wrong with the biometric check.';
  }
}

export function state() {
  return call({ action: 'state' });
}

export async function enrol(label) {
  const opts = await call({ action: 'options', purpose: 'enrol' });

  const created = await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(opts.challenge),
      rp: { name: 'Talkback' },
      user: {
        id: fromB64u(opts.userHandle),
        name: opts.userName,
        displayName: opts.userDisplay || opts.userName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      excludeCredentials: (opts.credentials || []).map((id) => ({
        type: 'public-key',
        id: fromB64u(id),
      })),
      timeout: 60000,
      attestation: 'none',
    },
  });
  if (!created) throw new Error('No passkey was created.');

  const response = created.response;
  if (typeof response.getPublicKey !== 'function') {
    throw new Error('This browser is too old to enrol a passkey here.');
  }
  const spki = response.getPublicKey();
  if (!spki) throw new Error('The device did not return a usable public key.');

  return call({
    action: 'enrol',
    credId: toB64u(created.rawId),
    publicKey: toB64u(spki),
    alg: response.getPublicKeyAlgorithm(),
    clientDataJSON: toB64u(response.clientDataJSON),
    label,
  });
}

export async function unlock() {
  const opts = await call({ action: 'options', purpose: 'verify' });

  const got = await navigator.credentials.get({
    publicKey: {
      challenge: fromB64u(opts.challenge),
      allowCredentials: (opts.credentials || []).map((id) => ({
        type: 'public-key',
        id: fromB64u(id),
      })),
      userVerification: 'required',
      timeout: 60000,
    },
  });
  if (!got) throw new Error('No passkey was offered.');

  const r = got.response;
  return call({
    action: 'verify',
    credId: toB64u(got.rawId),
    authenticatorData: toB64u(r.authenticatorData),
    clientDataJSON: toB64u(r.clientDataJSON),
    signature: toB64u(r.signature),
  });
}
