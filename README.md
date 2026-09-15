# Talkback

A private live voice line to Claude, on Base44. Speak, hear the reply, and keep
the transcript behind Face ID.

## Why Base44

This started as a Claude artifact, which could not be a private usable system:
it lives inside the claude.ai viewer, is organisation-internal, has no domain of
its own, and — being a cross-origin frame — depends on the embedder for both
microphone and WebAuthn permission. Base44 solves all of it at once: a public
`.base44.app` URL on a first-party origin, real auth, server-side functions, and
`InvokeLLM` with no API key to manage.

## How it is put together

```
src/                       frontend (React + Vite, iOS design language)
base44/entities/           VoicePasskey, VoiceChallenge, VoiceTurn
base44/functions/faceid/   WebAuthn ceremony + verification
base44/functions/voiceChat/ the brain, and the transcript
```

Two layers of identity, doing different jobs:

- **Base44 auth** answers *who is this* — the app is `requiresAuth: true`, so no
  route is reachable signed out.
- **Face ID** answers *is it really them, on this device, right now*. The line
  refuses to open for an account with no passkey enrolled, so a stolen session
  alone cannot talk to it.

## Face ID, precisely

WebAuthn with a platform authenticator and `userVerification: 'required'` — Face
ID or Touch ID on Apple devices, Hello on Windows, the device biometric on
Android. The biometric is checked by the operating system and never leaves the
device. The server stores one public key per device and verifies a signature per
unlock.

`base44/functions/faceid/entry.ts` runs the whole ceremony server-side, with no
library — Deno gives us WebCrypto:

- challenges are server-issued, single-use and consumed on verify, so a captured
  assertion cannot be replayed;
- `clientDataJSON.type` and `.origin` are checked, and the origin must equal the
  app's own origin rather than one the caller supplies;
- `rpIdHash` must equal SHA-256 of the pinned RP ID;
- UP must be set and **UV must be set** — that bit is what separates a real
  biometric check from a tap;
- ES256 is verified after the DER→raw conversion authenticators require; RS256
  verified directly;
- the signature counter must advance, which catches a cloned authenticator.

Passkeys are stored per Base44 user, so one person's device can never unlock
another's line.

## Voice

Speech in is the Web Speech API (Chrome, Edge, Safari; Firefox has none and gets
a text field instead). Speech out is `SpeechSynthesis`, spoken sentence by
sentence as the reply arrives rather than after the whole answer lands — that is
the difference between a live line and a walkie-talkie. Half duplex by default:
the microphone closes while Claude speaks so the synthesiser is never
transcribed as input.

The orb is driven by real signal — microphone RMS off an `AnalyserNode` while
listening, and `SpeechSynthesisUtterance` `onboundary` word events while
speaking.

## Local development

```bash
npm install
base44 dev          # local backend + frontend
npm run dev         # frontend only, against the hosted backend
```

`npm run build` works standalone; it warns about a missing `VITE_BASE44_APP_ID`
until the repo is linked to a Base44 app.

## To publish

This repo needs to be connected to a Base44 app, then published from the
dashboard (`base44 dashboard open`). It could not be done from the environment
this was written in: every `*.base44.com` host is refused by that network's
egress policy (403 on CONNECT), so the CLI cannot even reach the login endpoint.

## Traps worth keeping

- Consecutive same-role turns are read as ONE turn by most chat APIs, so a
  leading instructions turn merges with the speaker's first message and the
  model answers the instructions instead of the person. `voiceChat` keeps the
  transcript in a clearly delimited block after an explicit end-of-instructions
  marker.
- `SVGElement` does not reflect the `hidden` IDL property — it is defined on
  `HTMLElement`. `svg.hidden = true` sets a dead expando and `[hidden]` never
  matches; use `setAttribute`/`removeAttribute`.
- `functions.invoke()` returns the raw axios response — the JSON is on `.data`.
- `auth.login()` does not exist. It is `loginWithProvider()` or
  `loginViaEmailPassword()`.
- `getUserMedia` in a cross-origin frame fails *before* the browser can ask the
  user unless the embedder delegates `microphone`; WebAuthn likewise needs
  `publickey-credentials-get`. Both are moot on a first-party origin.
