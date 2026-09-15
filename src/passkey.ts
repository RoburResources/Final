/**
 * Face ID / Touch ID login, via WebAuthn platform authenticators.
 *
 * The biometric itself never leaves the device and never reaches this code —
 * the operating system checks the face or fingerprint locally and only then
 * lets the authenticator sign our challenge. We send the server a public key
 * once, and a signature each time we sign in.
 */

/**
 * The session is an httpOnly cookie set by the server, so nothing
 * security-relevant is reachable from JavaScript here.
 */
export async function post(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

/** Returns an ArrayBuffer, which is what WebAuthn's BufferSource fields want. */
function fromB64u(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toB64u(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type Supported = { ok: boolean; reason?: string };

export async function checkSupport(): Promise<Supported> {
  if (!window.isSecureContext) {
    return { ok: false, reason: 'This page needs to be on https for Face ID to work.' };
  }
  if (!('credentials' in navigator) || !window.PublicKeyCredential) {
    return { ok: false, reason: 'This browser does not support passkeys.' };
  }
  try {
    const available =
      await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) {
      return {
        ok: false,
        reason:
          'No built-in biometric was found on this device. Face ID, Touch ID, Windows Hello or an Android screen lock is required.',
      };
    }
  } catch {
    /* treat an unanswerable probe as available and let the real call decide */
  }
  return { ok: true };
}

/** Turn a WebAuthn DOMException into something worth reading. */
export function readableError(err: unknown): string {
  const e = err as { name?: string; message?: string; data?: { error?: string } };
  if (e?.data?.error) return e.data.error;
  switch (e?.name) {
    case 'NotAllowedError':
      return 'Cancelled, or the biometric check timed out. Try again.';
    case 'InvalidStateError':
      return 'This device is already enrolled — sign in instead.';
    case 'SecurityError':
      return 'The browser refused the request for this domain.';
    case 'AbortError':
      return 'The request was interrupted.';
    case 'NotSupportedError':
      return 'This device cannot create the kind of passkey we need.';
    default:
      return e?.message || 'Something went wrong with the biometric check.';
  }
}

export async function enrol(label: string, code?: string): Promise<void> {
  const opts = await post('/api/webauthn/options', { purpose: 'enrol', code });

  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(opts.challenge),
      rp: { name: 'Talkback' },
      user: {
        id: fromB64u(opts.userHandle),
        name: 'michael',
        displayName: 'Michael',
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
      excludeCredentials: (opts.credentials || []).map((id: string) => ({
        type: 'public-key' as const,
        id: fromB64u(id),
      })),
      timeout: 60000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;

  if (!created) throw new Error('No passkey was created.');
  const response = created.response as AuthenticatorAttestationResponse;

  if (typeof response.getPublicKey !== 'function') {
    throw new Error('This browser is too old to enrol a passkey here.');
  }
  const spki = response.getPublicKey();
  if (!spki) throw new Error('The device did not return a usable public key.');

  await post('/api/webauthn/enrol', {
    credId: toB64u(created.rawId),
    publicKey: toB64u(spki),
    alg: response.getPublicKeyAlgorithm(),
    clientDataJSON: toB64u(response.clientDataJSON),
    label,
    code,
  });
}

export async function signIn(): Promise<void> {
  const opts = await post('/api/webauthn/options', { purpose: 'verify' });

  const got = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64u(opts.challenge),
      allowCredentials: (opts.credentials || []).map((id: string) => ({
        type: 'public-key' as const,
        id: fromB64u(id),
      })),
      userVerification: 'required',
      timeout: 60000,
    },
  })) as PublicKeyCredential | null;

  if (!got) throw new Error('No passkey was offered.');
  const response = got.response as AuthenticatorAssertionResponse;

  await post('/api/webauthn/verify', {
    credId: toB64u(got.rawId),
    authenticatorData: toB64u(response.authenticatorData),
    clientDataJSON: toB64u(response.clientDataJSON),
    signature: toB64u(response.signature),
  });
}
