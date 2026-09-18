# Talkback — session rules

Plan of record: `docs/plan-voice-with-hands.md`. Tracking: Linear MIC-46 (project "Robur Work Register").

## Michael's standing rules

1. **Resolve blockers; never accept them.** When something is blocked — a host, a credential, a
   tool, a policy — find the root cause, fix what can be fixed from here, and for what cannot,
   state exactly what Michael must change (where, which setting, which value). "This is blocked"
   on its own is not an acceptable outcome.
2. **Research before asking.** Repos, the Linear register, mail and prior sessions are available.
   Ask only when the answer changes the outcome and cannot be found.
3. **Register first.** Read the Robur Work Register before acting; continue the issue you touch;
   never create a parallel issue, page or doc. Voice-with-hands work belongs on MIC-46.
4. **Deliver the highest-value correct version** of a request, and report what was asked, what was
   delivered, and where it went further.

## Network access in cloud sessions

This project needs egress to `elevenlabs.io`, `*.elevenlabs.io`, `*.replit.app`,
`*.up.railway.app` and `code.claude.com`. The "Default" cloud environment is **Trusted** (package
registries and GitHub only) and refuses these with a 403 on CONNECT. That is an environment
setting, not something a session can change:

- Check: `bash scripts/egress-preflight.sh` (also run by the SessionStart hook in single-repo
  cloud sessions; sessions opened across several repositories do not load repo hooks).
- Fix: claude.ai/code → environment selector → the environment's settings icon →
  **Network access** → **Full**, or **Custom** with the hosts above and "Also include default list
  of common package managers" ticked. Applies to sessions started afterwards.
- Do not route around a policy denial; the proxy README (`/root/.ccr/README.md`) says the same.

## Build

```sh
npm install
npm test          # WebAuthn + chat end-to-end, no API key, no spend
npm run build     # Vite production build
node --check server.js
```
