# WALL·E

A family chief of staff for exactly two people, Dan and Alina, living in WhatsApp. It triages the school inbox, briefs both adults twice a day, chases deadlines, holds one shared family memory with per-child spaces, and reads a locally built spending ledger. It asks before acting on the world and can never touch money.

The product sentence every feature serves: **logistics go to Wall-E, conversations stay ours.** Either adult tells Wall-E once; it reaches both briefs.

Built to the Execution PRD v5. One amendment agreed after the PRD: the model layer runs open-weight models (DeepSeek class) through an OpenAI-compatible host instead of the Anthropic API. The default host is OpenRouter with data collection set to deny, so only zero-retention providers serve requests; DeepInfra or any compatible host is a base-URL swap.

## Hard rules

1. Never send to anyone except the two allow-listed users. Enforced in one choke point (`src/send/outbound.ts`); no other code path reaches the channel.
2. Tier system. Tier 1 runs unattended (log, memory, briefs, drafts, reads). Tier 2 (calendar writes) requires an in-chat Yes on a proposal. Tier 3 (money, credentials, anything irreversible, anything child-facing, autonomous email) is not implemented anywhere.
3. Secrets live in env and clients only. A leak guard refuses any model request whose body contains a configured secret.
4. Read-only scopes everywhere they exist. The school principal is `gmail.readonly`; the ledger is a read-only file.
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
  school/    inbox poll, classify, extract, propose, deadline chasing
  briefs/    morning, evening, midday-conditional, Sunday rollup
  modelwatch/ weekly model-improvement suggestions from call telemetry
  google/    three OAuth principals; gmail, calendar, drive
  ledger/    POST /ledger endpoint + read-only summary reader
  scheduler/ node-cron registry (Asia/Riyadh) with probe-first jobs
  ops/       /health, nightly Drive backup
  dev/       console simulator (npm run dev:sim)
```

## P0 — Dan's prerequisites (blocking, in order)

1. Spare SIM active in a phone that can receive the WhatsApp registration SMS.
2. Meta developer app + WhatsApp Business Account; register the number; note the phone number id and WABA id.
3. Deploy this service to Railway (below) so the webhook URL exists; set the webhook to `https://<app>/webhook` with your `META_WA_VERIFY_TOKEN`; subscribe to `messages`.
4. Submit the `daily_brief` utility template (one body variable `{{1}}`, language `en`). Its approval status shows in `/health` once `META_WABA_ID` is set.
5. Create the school Gmail (e.g. kaziyev.school@gmail.com) and set BISR mail to redirect/forward into it.
6. Create a `walle` label in your and Alina's personal Gmail.
7. Google Cloud project with OAuth consent + a Desktop OAuth client; run `npm run auth -- school`, `-- dan`, `-- alina` locally and paste the three refresh tokens into Railway env.
8. Confirm Alina's WhatsApp number (`WA_ID_ALINA`).
9. Family Drive folder id (`FAMILY_DRIVE_FOLDER_ID`).
10. An OpenRouter (or DeepInfra) key with a few dollars of credit; a Groq key for voice notes.

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
| `GOOGLE_REFRESH_DAN`, `GOOGLE_REFRESH_ALINA`, `GOOGLE_REFRESH_SCHOOL` | from `npm run auth` |
| `FAMILY_DRIVE_FOLDER_ID` | the one Drive folder Wall-E may read; backups go to its `_walle-backup/` subfolder |
| `LEDGER_PUSH_TOKEN` | bearer token the Mac finance pipeline uses on `POST /ledger` (16+ chars) |
| `TZ` | `Asia/Riyadh` |
| `PORT`, `DATA_DIR` | default `3000`, `/data` |

## Railway

One service, one attached volume mounted at `/data`. Build `npm ci && npm run build`, start `npm start`. Set every env var above. The JSONL log, SQLite db, memory files, media and ledger all live on the volume; the nightly backup tars `/data` to Drive at 02:00.

## Day to day

- 06:30 and 21:00: morning and evening briefs, per user, ≤900 characters.
- 11:00–14:00: midday check every 30 minutes; messages only on a trigger, hard cap one per user per day; a quiet day is silence.
- School inbox: polled every 15 minutes 06:00–20:00, hourly overnight. Action or date emails become Yes/No/Change proposals to both parents; Yes writes the calendar event or opens a chased item (nudges at T-3d, T-1d, morning of).
- 23:30: memory curation (add / update / supersede) over the day's chat, one run per user so private facts can only land in that user's file.
- Sunday 20:00: weekly rollup. Dan's copy also carries adherence decay (reply rate under 70% over 14 days → the single suggestion "shorten the prompts") and the model-watch block: automated suggestions from the week's LLM telemetry (schema failure rates, retries, latency, spend). Suggestions are advisory; changing models is always a manual env change.
- 02:00: backup to Drive `_walle-backup/`, newest 14 kept.

## Commands

```
npm test                 # offline suite: 62 tests, no network, no keys
npm run typecheck
npm run dev:sim          # console simulator: "dan: pick up Dylan at 3", /morning dan, ...
npm run rebuild-db       # replay the JSONL log into a fresh SQLite db
npm run adoption-report  # day-28 metric: distinct unprompted inbound days per user
npm run auth -- school   # Google OAuth helper (also: -- dan, -- alina)
```

## Boring choices made where the PRD was silent

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
