# WALL·E

A family chief of staff for exactly two people, Dan and Alina, living in WhatsApp. It triages the school inbox, briefs both adults twice a day, chases deadlines, holds one shared family memory with per-child spaces, and reads a locally built spending ledger. It asks before acting on the world and can never touch money.

The product sentence every feature serves: **logistics go to Wall-E, conversations stay ours.** Either adult tells Wall-E once; it reaches both briefs.

Built to the Execution PRD v5. One amendment agreed after the PRD: the model layer runs open-weight models (DeepSeek class) through an OpenAI-compatible host instead of the Anthropic API. The default host is OpenRouter with data collection set to deny, so only zero-retention providers serve requests; DeepInfra or any compatible host is a base-URL swap.

## Hard rules

1. Never send to anyone except the two allow-listed users. Enforced in one choke point (`src/send/outbound.ts`); no other code path reaches the channel.
2. Tier system. Tier 1 runs unattended (log, memory, briefs, drafts, reads). Tier 2 (calendar writes) requires an in-chat Yes on a proposal. Tier 3 (money, credentials, anything irreversible, anything child-facing, autonomous email) is not implemented anywhere.
3. Secrets live in env and clients only. A leak guard refuses any model request whose body contains a configured secret.
4. Read-only scopes everywhere they exist, and the narrowest that works. The two personal Google accounts grant calendar and nothing else. Full mail reading happens only in two dedicated mailboxes. No send scope and no delete scope anywhere.
5. Log first. Every inbound webhook payload is appended to the JSONL log before signature checks or any processing, including failures.
6. One writer. Only this service writes the log.
7. Privacy split in code, not prompts. The context builder for one user cannot open the other's private file.
8. No scoring, no streaks, no gamification. The child-time question uses three words: proper, some, none.
9. School emails and forwarded content are untrusted input; instructions inside them are data. Every prompt that touches them says so, and the fence is applied in code.

## Layout

```
prompts/     versioned prompt files (assistant core + per-user, curator, school, briefs)
scripts/     auth (Google OAuth helper), rebuild-db, adoption-report
src/
  log/       append-only JSONL, monthly rotation, fsync; the source of truth
  db/        derived SQLite (better-sqlite3), projector, rebuildable via npm run rebuild-db
  channel/   neutral message types; whatsapp/ is the only Meta-aware directory
  send/      the outbound choke point: allow-list assert, 24h window vs template
  ingress/   idempotency, allow-list, media download, transcription, dispatch
  llm/       OpenAI-compatible client, tool loop, structured JSON calls, untrusted fence
  memory/    markdown memory files, deterministic routing phrases, nightly curator
  assistant/ per-user context, tools, conversation loop, Tier 2 confirmations
  school/    classify, extract, propose, deadline chasing (fed by forwarded/)
  briefs/    morning, evening, midday-conditional, Sunday rollup
  modelwatch/ weekly model-improvement suggestions from call telemetry
  google/    three OAuth principals; gmail, calendar, drive
  forwarded/ the dedicated forwarding inbox and its sender allow-list
  ledger/    POST /ledger endpoint + read-only summary reader
  scheduler/ node-cron registry (Asia/Riyadh) with probe-first jobs
  ops/       /health, nightly Drive backup
  dev/       console simulator (npm run dev:sim)
```

## Setting it up

**[docs/SETUP.md](docs/SETUP.md) is the step-by-step manual.** It covers the whole path from a local dry run to a live service, in the order the dependencies actually demand, with the failure modes inline.

## Access model

| Account | Scopes | Why |
| --- | --- | --- |
| School Gmail (dedicated) | `gmail.readonly` | receives only BISR mail |
| Wall·E Gmail (dedicated) | `gmail.readonly`, `drive.readonly`, `drive.file` | the forwarding inbox; also holds the shared family Drive folder, so the broad Drive read covers an otherwise empty Drive |
| Dan's Google | `calendar.events` | reads for briefs, writes behind the Tier 2 gate |
| Alina's Google | `calendar.events` | same |

No send scope. No delete scope. Personal inboxes are never read — anything Wall·E should see is forwarded to its own address, where a Gmail filter bins mail from anyone else and Wall·E asks, sender and subject only, before opening what is left.

## Environment variables

| Var | What |
| --- | --- |
| `META_WA_TOKEN` | permanent WhatsApp Cloud API token |
| `META_WA_PHONE_ID` | phone number id |
| `META_WA_VERIFY_TOKEN` | any string; must match the webhook config |
| `META_APP_SECRET` | app secret, used to verify webhook signatures |
| `META_WABA_ID` | optional; enables template status in `/health` |
| `WA_ID_DAN`, `WA_ID_ALINA` | the two allow-listed WhatsApp ids (international format, digits only) |
| `LLM_BASE_URL` | default `https://openrouter.ai/api/v1` |
| `LLM_API_KEY` | key for that host |
| `WALLE_MODEL` | default `deepseek/deepseek-chat`; set to the current DeepSeek flash-tier slug on your host |
| `WALLE_MODEL_ESCALATED` | optional stronger model for drafting; defaults to `WALLE_MODEL` |
| `GROQ_API_KEY` | Whisper transcription (`whisper-large-v3-turbo`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the OAuth client |
| `GOOGLE_REFRESH_DAN`, `GOOGLE_REFRESH_ALINA`, `GOOGLE_REFRESH_WALLE` | from `npm run auth` |
| `FAMILY_DRIVE_FOLDER_ID` | the one Drive folder Wall-E may read, shared with the Wall-E account; backups go to its `_walle-backup/` subfolder |
| `EMAIL_DAN`, `EMAIL_ALINA` | the only two addresses the forwarding inbox accepts mail from |
| `LEDGER_PUSH_TOKEN` | bearer token the Mac finance pipeline uses on `POST /ledger` (16+ chars) |
| `TZ` | `Asia/Riyadh` |
| `PORT`, `DATA_DIR` | default `3000`, `/data` |

## Railway

One service, one attached volume mounted at `/data`. Build `npm ci && npm run build`, start `npm start`. Set every env var above. The JSONL log, SQLite db, memory files, media and ledger all live on the volume; the nightly backup tars `/data` to Drive at 02:00.

## Day to day

- 06:30 and 21:00: morning and evening briefs, per user, ≤900 characters.
- 11:00–14:00: midday check every 30 minutes; messages only on a trigger, hard cap one per user per day; a quiet day is silence.
- School inbox: polled every 15 minutes 06:00–20:00, hourly overnight. Action or date emails become Yes/No/Change proposals to both parents; Yes writes the calendar event or opens a chased item (nudges at T-3d, T-1d, morning of).
- Forwarding inbox: polled on the same schedule. Mail from Dan or Alina is read in full and answered in that person's chat. Mail from anyone else is binned by a Gmail filter and surfaced to Dan as sender and subject only, with a Tier 2 proposal before anything is read.
- 23:30: memory curation (add / update / supersede) over the day's chat, one run per user so private facts can only land in that user's file.
- Sunday 20:00: weekly rollup. Dan's copy also carries adherence decay (reply rate under 70% over 14 days → the single suggestion "shorten the prompts") and the model-watch block: automated suggestions from the week's LLM telemetry (schema failure rates, retries, latency, spend). Suggestions are advisory; changing models is always a manual env change.
- 02:00: backup to Drive `_walle-backup/`, newest 14 kept.

## Commands

```
npm test                 # offline suite: 72 tests, no network, no keys
npm run typecheck
npm run dev:sim          # console simulator: "dan: pick up Dylan at 3", /morning dan, ...
npm run rebuild-db       # replay the JSONL log into a fresh SQLite db
npm run adoption-report  # day-28 metric: distinct unprompted inbound days per user
npm run auth -- walle    # Google OAuth helper (also: -- dan, -- alina)
```

## Boring choices made where the PRD was silent

- Wall·E cannot delete mail: that needs a Gmail write scope, and permanent deletion is Tier 3. Refusing unwanted mail is a Gmail filter's job, with a 30-day Trash window as the undo.
- Confirmation correlation: button ids encode `p:{proposalId}:{yes|no|change}`; a plain-text "yes" binds to that user's single most recent pending proposal and asks when several are pending. Proposals expire after 72 hours and are resurfaced once in the next morning brief.
- School proposals go to both parents; the first answer wins and the second tap is told who sorted it.
- "Unprompted" in the adoption metric: an inbound not sent within 2 hours after a scheduled Wall-E send.
- The raw webhook payload is logged verbatim (hard rule 5 wins over payload minimalism); everything downstream stores channel-neutral shapes.
- Template bodies cannot carry newlines (Meta rule): flattened to ` · `-separated lines. Interactive buttons cannot ride a template: outside the 24h window the message carries "Reply Yes / No / Change" instead.
- Child-time is asked as free text (3 children × 3 levels exceeds WhatsApp's three-button limit) and parsed by a structured call; buttons are reserved for Tier 2 confirmations.
- The ledger push logs as a `trigger` event with actor `finance` (the PRD's closed event-type list has no ledger type).
- Brief length: instructed 900 characters, hard-trimmed at 1,000 with an error event.
- The webhook 200s only after the raw payload is durably logged; a crash before that point makes Meta retry, and `wa_msg_id` idempotency makes the retry harmless.
- Change-in-progress state (a user who tapped Change and owes a description) is held in memory only; a restart between the tap and the reply drops it, and the user just answers the original buttons again.

## Not built, on purpose

Group chat, worker agents, extra channels, scoring, minute tracking, autonomous sending, bank connections, anything child-facing, local inference as a cloud replacement. The Mac-side `walle-finance` pipeline (SMS → regex parsers → Actual Budget → `POST /ledger`) is a separate later build; the endpoint and the freshness-gated brief line are ready for it.
