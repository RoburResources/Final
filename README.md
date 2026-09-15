# Talkback

A private live voice line to Claude. You speak; it answers out loud. It runs on
its own URL, behind a Face ID login, and the transcript stays on the server.

```
browser                                  server (Node + Express)
  Face ID / Touch ID ── passkey ───────►  WebAuthn verified in WebCrypto
  microphone → speech recognition ─────►  /api/chat  ──► Claude (streamed)
  speech synthesis ◄─── sentences ─────   SSE, sentence by sentence
  transcript ◄─────────────────────────   store.json
```

## Why it is not a Claude artifact

The first version of this was one, and an artifact can never be the private
usable system that was wanted. It lives inside the claude.ai viewer, is
organisation-internal, has no domain of its own, and — being a cross-origin
frame — depends on the embedder for both microphone and WebAuthn permission.
That last point is not a detail: `getUserMedia` in a cross-origin frame fails
*before* the browser can even ask, unless the embedder delegates `microphone`.
WebAuthn is the same, via `publickey-credentials-get`. On its own origin, all
of that simply goes away.

## Run it on Replit

1. **Create the Repl.** In Replit, choose *Create* → *Import from GitHub* and
   point it at this repository and branch.
2. **Add the key.** Open *Secrets* (the padlock) and add:

   | Secret | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
   | `TALKBACK_CLAIM_CODE` | any hard-to-guess string — see below |

3. **Press Run.** It installs, builds the UI and starts the server on one port.
4. **Open the URL on your phone**, enter the setup code, and tap *Set Up Face
   ID*. That enrols your phone and claims the app.
5. **Deploy** when you want it to stay up without the editor open. The included
   `.replit` targets a Reserved VM, which keeps a persistent disk — see
   *Where state lives*.

It is plain Node and Express with no platform SDK, so the same repository runs
unchanged on Railway, Render, Fly, or your own laptop.

### Locally

```sh
npm install
npm run dev      # Vite on :5173, API on :3000, /api proxied across
npm test         # 35 checks, no API key needed, no spend
npm run serve    # build once and serve everything from :3000
```

## Face ID, honestly

"Face ID" here is WebAuthn with a platform authenticator and
`userVerification: 'required'`. On an iPhone or a Mac that is literally Face ID
or Touch ID; on Windows it is Hello; on Android it is the device biometric.

What matters is *where the biometric is checked*: **on the device, by the
operating system**. No face data is transmitted, stored, or seen by this app.
Enrolment sends one public key. Every later sign-in sends a signature verified
against that key.

`lib/webauthn.js` does the whole ceremony rather than trusting the client:

- challenges are server-issued, single-use, and consumed on verify, so a
  captured assertion cannot be replayed;
- `clientDataJSON.type` and `.origin` must match the ceremony and the origin
  pinned at enrolment;
- `rpIdHash` in the authenticator data must equal SHA-256 of the pinned RP ID;
- the UP flag must be set, and the **UV flag must be set** — that bit is what
  distinguishes a real biometric check from a mere tap;
- the signature is verified with WebCrypto: ES256 over ECDSA P-256, including
  the DER→raw conversion authenticators require, or RS256;
- the signature counter must advance, which catches a cloned authenticator.

Sessions are HMAC-signed tokens in an httpOnly cookie, so nothing
security-relevant is reachable from JavaScript. They expire after 30 days.

All of the above is covered by `test/webauthn.e2e.mjs`, which drives the real
server with a synthetic authenticator built on WebCrypto — a genuine ceremony,
DER signatures and all — and then tries to break in eleven ways.

`test/browser.faceid.mjs` goes one further and runs the actual UI in Chromium
against a virtual platform authenticator, so the lock screen, the setup code,
`navigator.credentials`, both ceremonies and the unlocked console are exercised
the way the phone will exercise them. It needs Playwright, so it is not part of
`npm test`:

```sh
npm install --no-save playwright && npx playwright install chromium
npm run test:browser
```

### Who may claim it

The first passkey **claims** the app and pins its origin; after that,
registration requires an existing valid session, so a public URL cannot be
taken over once you have enrolled.

On its own that is trust-on-first-use, and it is only safe if you enrol
promptly. Setting `TALKBACK_CLAIM_CODE` closes the gap: claiming then also
requires the code, so nobody who happens on the URL first can take it — and a
host that wipes the disk cannot hand your app to a stranger. Set it. The lock
screen asks for the code only while the app is unclaimed.

## Where state lives

Everything is one JSON file, `data/store.json`: the enrolled credentials, the
session-signing key, live challenges, and the transcript. Nothing is
relational; swapping it for Postgres or SQLite is a small, contained change.

Some hosts wipe the filesystem on redeploy or run several instances. If yours
does, the passkey and transcript go with it. A few environment variables cover
that, and one more picks the model:

| Variable | What it does |
| --- | --- |
| `TALKBACK_DATA_DIR` | put the store on a mounted disk instead of beside the code |
| `TALKBACK_HMAC_KEY` | keep the session key out of the store, so a wipe does not sign you out |
| `TALKBACK_CLAIM_CODE` | stop a wiped store from being claimable by anyone but you |
| `TALKBACK_MODEL` | override the model; defaults to Claude Opus 5 |

## Speaking, not writing

The system prompt asks for spoken English: short replies, no markdown, no
bullets, numbers expanded so a synthesiser reads them properly, and a tolerance
for speech recognition mangling the odd word.

The reply is streamed and spoken sentence by sentence as it arrives rather than
waiting for the whole thing, which is most of what makes it feel like a line
rather than a form. The microphone is gated while Claude speaks, so it does not
transcribe its own voice.

## Traps found building this

- `sample` and most chat APIs read consecutive same-role turns as **one** turn,
  so a leading `user` instructions turn merges with the speaker's first message
  and the model answers the instructions instead of the person. Here the brief
  is a `system` prompt, which cannot merge — and the test asserts it.
- `SVGElement` does not reflect the `hidden` IDL property; it is defined on
  `HTMLElement`. `svg.hidden = true` sets a dead expando and the `[hidden]`
  rule never matches. Use `setAttribute`/`removeAttribute`.
- A side effect inside a `setState` updater runs twice under StrictMode.
- WebCrypto signs ECDSA as raw `r||s`; authenticators send DER. Verification
  has to convert, and a test that skips the conversion passes for the wrong
  reason.
- `output_config.effort` is on the beta message surface, not the stable one.
  The server asks for low effort and quietly retries plainly if refused.
