# Talkback v3 — a live voice line with hands

Plan of record for the build tracked as Linear **MIC-46** ("VOICE BRIDGE — Claude Code ↔ voice
Claude shared channel"). Written 18 Sep 2026 from the voice transcript Michael handed over, the
repos in this session, the ElevenLabs workspace, the Addison governance contracts and the Robur
Work Register. It supersedes the comment-polling bridge described on MIC-46; that channel stays
as a fallback for terminal sessions.

## 0. What the brief actually asks for

Michael's words, reduced to the properties the system must have:

1. **The line never stops.** Thinking and task execution happen alongside the conversation, never
   instead of it. He keeps talking; work runs; results arrive on the line.
2. **Any task, any size.** Long-running and short, from the same conversation.
3. **Interpret, then raise the bar.** Every request is ingested, the real outcome behind it is
   inferred, and what gets executed is the *highest-value correct* version — not merely the
   literal ask. Report both: what was asked, what was delivered, where it went further.
4. **Don't interrogate him.** Resolve questions from history, files and context. Ask only when the
   answer changes the outcome and cannot be found.
5. **Sounds like a person.** "Indistinguishable from a human voice conversation" is the benchmark.
6. **Feels like one Claude.** The voice and the hands share one context; the voice never says
   "hand this to Claude Code".

The dominant variable is (1). Everything else is either a quality lever on top of it or a policy.

## 1. What exists today (verified 18 Sep)

| Piece | State | Evidence |
| --- | --- | --- |
| Talkback v1 (claude.ai artifact) | Works only inside the claude.ai viewer; mic and WebAuthn blocked by the cross-origin frame; "relay" is an artifact-DB mailbox that Claude Code must poll. Published *shareable by link*. | `README.md` §"Why it is not a Claude artifact"; artifact `a769c050…` |
| Talkback v2 (this repo, `Final`) | Node/Express + React. Face ID via WebAuthn, `/api/chat` streams Claude sentence by sentence, browser Web Speech for STT/TTS, half-duplex (mic closes while it speaks), `data/store.json`. Deployed on Replit at `devoted-firsthand-queryoptimizer.replit.app`, **locked and unanswering**: no `ANTHROPIC_API_KEY` set, no passkey enrolled. No hands. | `server.js`, `src/voice.ts`, session `014ZAK5o…` summary |
| ElevenLabs agent "Talkback — live line to Claude" | `agent_7301m2krd6fnfyd93d6d750pk7mm`. Scribe realtime ASR, `turn_v3` turn-taking, `eleven_flash_v2` TTS, brain = `claude-sonnet-5` **hosted by ElevenLabs**, no tools, no memory, 10-minute cap, 0 calls made. | `agents_get` |
| Prior hands attempt | ElevenLabs webhook tool `create_task` → Task Command Center on Railway (`/api/agent-tools/v1/create-task`, picks model + `full_build/quick_fix/research_only`). 14 calls. Repo not in the GitHub org; liveness unknown (egress blocked from this sandbox). | `agents_list_tools` |
| Addison (`addison-executive`) | Governed executive kernel with a voice control plane already designed and partly built: command envelope, continuity store, approval binding (L3 voice / L4 on-screen), kill switch. Overall `NOT_READY`. A 28 Aug Codex lane locked a **zero-incremental-cost** voice policy (local STT/TTS on the Windows host, LAN only, no ElevenLabs/Retell/API billing) and has been blocked since on "Windows host offline" (Desktop Commander offline since 31 Aug per MIC-46). | `src/voice/*`, `control/constitution.json`, `control/voice-zero-cost-policy.json` (research branch) |
| Money | Card 9242 failing took services down in Aug/Sep; cards 7066 and 7752 work; **Replit Pro restored 3 Sep**. Constitution: automatic spend AUD $0, any spend needs exact approval bound to an amount. | MIC-20, MIC-42, constitution `spending` |
| Register rule | Every session reads the Robur Work Register first, continues existing issues, never creates parallel pages. | MIC-38 |

Two lanes were built in the last three weeks that contradict each other: the Addison lane says
"zero cost, local, LAN" and is blocked; the Talkback lane says "paid ElevenLabs + API key on
Replit" and is unactivated. The brief ("indistinguishable from human", used from an iPhone
anywhere) cannot be met by the local lane on current hardware, and the local lane has no path
while the Windows host is offline. This plan takes the Talkback lane and converts the cost
conflict into what the constitution actually requires: **one exact spend approval** (§6, Q1).

## 2. Target architecture

```
iPhone / desktop browser — Talkback app on its own origin (Replit Reserved VM), Face ID login
  │  WebRTC audio via @elevenlabs/client; conversation token minted by our server after Face ID
  ▼
ElevenLabs Agents  — the AUDIO PLANE only: streaming ASR, turn-taking, barge-in, TTS
  │  custom LLM → POST https://<talkback>/api/brain   (OpenAI-compatible streaming, bearer secret)
  ▼
Talkback server (Node/Express — this repo)
  ├─ BRAIN   Claude (Opus 5) streaming, effort=low. Prompt = voice brief + Michael context pack
  │          + live task board. Server-side tools: dispatch_task, task_status, cancel_task,
  │          answer_hands, approve. Never exposed to ElevenLabs; no secrets leave the server.
  ├─ TASK BUS  durable ledger: tasks{id, brief, state, authority, session_id, cost, events[]}
  │          SSE /api/tasks/stream for the browser; JSON store now, Postgres later.
  ├─ HANDS   worker process on @anthropic-ai/claude-agent-sdk `query()`; one session per task,
  │          streaming input kept open so follow-ups and answers go into the *same* session;
  │          `resume` by session id; `canUseTool` = authority ladder; hooks write every tool
  │          call to the ledger; `maxBudgetUsd` per task; `abortController` on "stop".
  │          Tools: Read/Edit/Write/Bash/Grep/Glob/WebSearch/WebFetch + MCP servers with token
  │          auth (GitHub, Linear, Notion, Zapier MCP, ElevenLabs).
  └─ RELAY   browser SSE consumer → conversation.sendContextualUpdate() for progress,
             sendUserMessage("[HANDS] …") for completions/questions so the voice raises them
             at the next natural gap. Nothing here blocks the audio plane.
```

Why each boundary sits where it does:

- **ElevenLabs owns audio, not thinking.** Turn-taking, interruption, ASR and TTS are the parts
  where the benchmark is decided and where nobody should be hand-rolling. Their tool `execution_mode`
  supports `immediate | post_tool_speech | async` (verified from the API schema), but a tool result
  is still capped at 300 s and a task can run for an hour — so long-running work cannot ride on
  ElevenLabs tools. Hence the task bus + relay.
- **The brain lives in our server, not in ElevenLabs.** That is what makes it *one* Claude: it sees
  the transcript, the task board, Michael's standing rules and can dispatch/answer/approve in the
  same turn. It also removes credentials from ElevenLabs tool configs (see §7).
- **Hands are Claude Code.** The Agent SDK is Claude Code as a library: the same tools, hooks,
  permissions and sessions this session runs on. Streaming-input sessions stay open, so a task
  can receive "actually, use the other repo" without restarting, and `resume` survives a restart.
- **Web Speech is the fallback, not the product.** It stays behind a flag for when ElevenLabs is
  unreachable or unpaid; it is not the benchmark path.

### 2.1 The "raise the bar" loop (property 3)

Dispatch is never a raw transcript. Before creating a task the brain writes a **brief**:

```
asked:        the literal request, in his words
goal:         the outcome he is actually after (inferred from context, history, register)
done_when:    observable completion — a PR link, a sent draft, a number with a source
scope:        repos / systems / data the hands may touch for this
ceiling:      highest authority level allowed without coming back (L0–L4, §3)
upgrade:      what a stronger version would add, if it fits scope and ceiling
```

The hands execute the brief with a standing rule: deliver `asked`, then the best `upgrade` that fits
`scope`/`ceiling`, verify against `done_when`, and return a report shaped for speech — three lines:
*asked / delivered / went further* — plus links. The brain speaks the report, never the log.
Questions from the hands (`AskUserQuestion`) are posted to the ledger, spoken at the next gap, and
Michael's answer is fed back into the still-open session. Property 4 is enforced in the hands'
prompt: research first (repo, register, history), ask only when the answer changes the outcome.

## 3. Authority ladder (the answer to "should it ask first")

Michael's answer was "yes and no — it depends on the task". The constitution already encodes the
dependency, so the policy is reused rather than re-asked:

| Level | Examples | Who decides |
| --- | --- | --- |
| L0 observe | read repos, search, fetch, read the register, read mail metadata | hands, autonomous |
| L1 prepare | plans, drafts, branches, draft PRs, private files | hands, autonomous |
| L2 reversible internal | edit code on a branch, run tests, comment on an existing Linear issue | hands, autonomous |
| L3 external effect | send email/SMS, post publicly, merge to a default branch, create a new register issue | spoken exact approval: the brain reads the packet back (recipient + content digest), "yes" binds to that packet only |
| L4 money / production / credentials / destructive | pay, deploy prod, rotate secrets, delete data | on-screen tap in the Talkback app; voice alone is insufficient |
| stop | "stop" interrupts speech; "stop the task" aborts the hands session (files kept, resumable) | immediate |

Implemented as `canUseTool` + `PreToolUse` hooks in the hands (hooks run before every other
permission step, so they hold even in `bypassPermissions`), and as a server check on the brain's
`approve` tool. Ambiguous "yes/okay" never creates work unless exactly one proposal is pending
(Addison's `classifyVoiceCommand` rule, ported).

## 4. Phases

Each phase is independently testable through the UI that already exists (the type bar works
without any voice change). Effort is in Claude Code sessions, not days.

### Phase 0 — Activate what is already built (Michael, ~30 min, no code)

- Replit → Secrets: `ANTHROPIC_API_KEY`, `TALKBACK_CLAIM_CODE`, `TALKBACK_HMAC_KEY`,
  `TALKBACK_DATA_DIR` (mounted disk). Open the URL on the phone, enter the code, Set Up Face ID.
- Say one thing, hear one answer. This is the baseline everything below is measured against.
- Give the spend approval in §6 Q1.

### Phase 1 — Hands and task bus (1–2 sessions)

Files: `server/tasks.js` (ledger + SSE), `server/hands.js` (Agent SDK worker), `server/authority.js`,
`server.js` routes `/api/tasks` (`POST` create, `GET` list, `GET /stream`, `POST /:id/cancel`,
`POST /:id/answer`), `src/TaskRail.tsx` (a thin list under the orb: running / needs you / done).

- Ledger is written before the session starts and on every hook event; restart marks orphaned
  `running` tasks `interrupted` and offers `resume`.
- One Agent SDK session per task, `cwd` = a per-task checkout under `TALKBACK_DATA_DIR/work`,
  `maxBudgetUsd` default 3, daily cap in env, cost recorded from the `result` message.
- Hands prompt = brief (§2.1) + standing rules + register-first rule (MIC-38).
- MCP servers configured from env: GitHub (fine-grained PAT scoped to RoburResources), Linear,
  Notion, Zapier MCP, ElevenLabs. Missing token ⇒ that server is absent, not a crash.
- Tests (no spend): ledger recovery, authority denials, budget cap, SSE ordering, with a fake
  runner. One gated smoke test (`HANDS_SMOKE=1`) runs a real one-file task end to end.

Acceptance: type "add a CI badge to the README in Final" → task appears in the rail → draft PR
link lands in the transcript → you were able to keep typing/talking the whole time.

### Phase 2 — The brain moves server-side and gets tools (1 session)

Files: `server/brain.js` (one module behind both `/api/chat` and the new `/api/brain`),
`server/brief.js` (intent compiler), `server/openai-compat.js` (Chat-Completions stream shape).

- `/api/brain` implements the OpenAI-compatible streaming contract ElevenLabs' custom-LLM option
  expects, guarded by its own bearer secret (stored in the ElevenLabs secret store, not in code).
- Brain tools are executed inside the request; the reply keeps streaming while a dispatch is
  written. Task board (running / needs you / done since last turn) is injected each turn.
- Spoken-report rules: results in ≤ 3 sentences, numbers expanded, links kept for the transcript.
- Anthropic request hygiene: streaming, `output_config.effort: "low"` for speech turns, server-side
  refusal fallback enabled, transcript window cached as a stable prefix.

Acceptance: while a task runs, ask something unrelated — answered without pause; when the task
completes, the next reply mentions it unprompted; "stop the task" aborts within 2 s.

### Phase 3 — Voice engine swap to ElevenLabs (1–2 sessions) — the benchmark phase

Files: `server/voice-session.js` (mint conversation token only for a signed-in passkey session),
`src/voice-el.ts` (WebRTC client, relay consumer), ElevenLabs agent update.

- Agent: custom LLM → `/api/brain`; keep `turn_v3`; raise `max_duration_seconds`; `auth.enable_auth`
  + origin allowlist; evaluate `eleven_flash_v2_5` vs `eleven_v3` for latency/quality; keep the
  current voice until a blind A/B says otherwise.
- Client: replace Web Speech as the default path; keep it behind `?engine=web` as fallback.
  Relay: SSE → `sendContextualUpdate` (progress, silent) / `sendUserMessage` (completion, question,
  approval request — spoken at the next gap). Barge-in is native.
- Instrument: end-of-speech → first audio, barge-in → silence, task-finish → spoken, per turn.

Acceptance (p50 over 20 turns on the phone, on cellular): first audio ≤ 1.2 s; barge-in ≤ 300 ms;
task completion spoken ≤ 5 s after it finishes; no turn ever blocked on a task.

### Phase 4 — Context pack and memory (1 session)

- `context/michael.md`: standing rules (from the ElevenLabs prompt + this repo's brief), authority
  ladder, preferences already compiled in earlier sessions, current projects. Loaded by brain and
  hands. Sources ranked: register > repo docs > transcript.
- Session memory: a rolling summary per line, persisted with the transcript; the brain opens with
  what is still running from last time.
- Register-first: at line open the brain reads the Robur Work Register (read-only) so "what's
  waiting on me" is answerable without a task.

### Phase 5 — Hardening and certification (ongoing, reuse Addison's model)

- Restart during a running task; kill switch; approval replay resistance (nonce + expiry, ported
  from `approval-binding.ts`); no secret in transcripts or prompts.
- Blinded voice check with the VOICE-001 rubric (MOS, task success) — pass/fail is measured, not
  claimed. 72-hour soak with the daily cost ledger visible.

## 5. What would make this fail, and the earliest signal

| Risk | Earliest observable signal | Response |
| --- | --- | --- |
| Voice still feels like a form (turns block on thinking) | Phase 2 acceptance: a reply that waits for a tool | Move the tool off the request path; never await hands inside `/api/brain` |
| Hands do the literal thing, not the valuable thing | Reports with an empty "went further" line three tasks in a row | Fix the brief compiler and hands prompt before adding tools |
| Cost runs away | Daily ledger > approved ceiling, or any task > `maxBudgetUsd` | Caps are code, not prompts; the brain says the number when asked |
| Hands act outside scope | An L3 event in the ledger without an approval packet | Hook denial is the control; add a test per incident |
| ElevenLabs custom-LLM latency too high on Opus at low effort | Phase 3 p50 first audio > 1.5 s | Effort/thinking tuning first; Sonnet 5 for speech turns only if measurement forces it |
| Replit billing lapses again | `/api/state` unreachable | Railway is the fallback host; the app is plain Node and moves unchanged |

The recommendation changes if (a) Michael declines paid voice — then the local lane becomes the
only path and needs the Windows host online first; or (b) Task Command Center turns out to be a
working Claude Code executor — then Phase 1 shrinks to an adapter.

## 6. Decisions taken, and the three questions that are Michael's

Decisions (overridable by a sentence on the line):

- **D1** Build is this repo (`Final`), on its own origin. Not the artifact (no mic), not Addison
  (governance-locked, `NOT_READY`, private/business boundary).
- **D2** ElevenLabs is the audio plane. The local zero-cost lane cannot meet the benchmark on
  current hardware and is blocked while the Windows host is offline.
- **D3** The brain runs in our server on Claude; ElevenLabs hosts no reasoning.
- **D4** Hands are the Claude Agent SDK on the same host, one session per task, authority ladder
  in hooks. Claude Code Remote sessions (which already carry Michael's Gmail/Calendar/Xero
  connectors) are a later lane for connector-heavy tasks, not the always-on executor.
- **D5** Authority ladder is the constitution's, reused as policy. Talkback is a personal line with
  business hands; Addison stays separate and its private memory is never read by Talkback.
- **D6** MIC-46 is the tracking issue (register rule: continue, never create). Its comment-polling
  channel remains available for terminal sessions but is no longer the bridge.
- **D7** Host stays on Replit (Pro restored 3 Sep); Railway is the fallback.
- **D8** Keep the current ElevenLabs voice until a blind A/B; no voice claim before measurement.

Questions (each changes the build; nothing else is being asked):

- **Q1 Spend.** The constitution needs an exact ceiling. Proposal: ElevenLabs conversational
  minutes up to **AUD 150/month** and Anthropic API usage up to **AUD 250/month**, both capped in
  code. Also: if the Claude subscription includes the programmatic (Agent SDK / `claude -p`)
  credit, the hands can run on it without an API key — verify on the account; it changes the
  Anthropic number.
- **Q2 Task Command Center.** Is `task-command-center-production-6542.up.railway.app` alive, and
  does it already run Claude Code tasks? If yes, Phase 1 becomes an adapter to it.
- **Q3 Scope of the hands in v1.** Proposal: all RoburResources repos (branches and draft PRs
  only), Linear comments on existing issues, Zapier MCP read-only for mail/calendar/Xero. Anything
  outside that waits for an L3 packet.

## 7. Suggestions outside the plan

- Two credentials sit in ElevenLabs tool configs in plain view of anything that lists tools: the
  Task Command Center bearer in `create_task`, and the Zapier MCP token embedded in a server URL.
  Rotate both; use the ElevenLabs secret store for headers.
- The v1 artifact is shared "anyone with the link" and its relay writes conversation turns into an
  artifact database. Unshare it once v2 answers.
- The four other repos on this branch (`1`, `Doc-flow`, `docuflow-ai`, `flowserve`) are untouched;
  the branch exists there only because the session was opened across all seven.
