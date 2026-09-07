# Taking Wall·E live

A step-by-step manual. Follow it in order — the sequence matters, and section 7 explains why.

Roughly 90 minutes, most of it waiting on Google and Meta. You need a payment card for OpenRouter (a few dollars covers a month) and a phone to hand.

---

## 0. What Wall·E will and will not be able to do

Read this before you click through any consent screen, so nothing surprises you.

**Three Google accounts, three grants:**

| Account | What it can do |
| --- | --- |
| Wall·E Gmail (new, dedicated) | Read everything in that mailbox, including Trash. School mail and your forwards both land here. Also reads the family Drive folder you share with it, and writes backup archives it creates. |
| Your personal Google | Read and write **calendar events**. Nothing else. |
| Alina's personal Google | Read and write **calendar events**. Nothing else. |

**What it can never do, on any account:** send an email, delete an email, read a body from your or Alina's personal inbox, touch money, or message anyone but the two of you.

**The bigger privacy fact, and it isn't a Google one:** whatever goes into a prompt reaches your model provider. That means brief content, school email text, forwarded email text, your memory files and your chat messages, going to OpenRouter and on to whichever DeepSeek host serves the request. Voice notes go to Groq as audio. The code pins OpenRouter to providers that do not retain data, but the exposure is real and you should know its shape. Your API keys and OAuth tokens never enter a prompt; a guard refuses any request containing one.

---

## 1. Hear it before Alina does (10 minutes, no accounts)

```bash
git clone https://github.com/d-kazi/walle && cd walle
npm install
DATA_DIR=./devdata npm run dev:sim
```

You get a prompt. Commands:

```
dan: pick up Dylan at 3        an inbound message from you
alina: gala is Thursday        an inbound message from Alina
dan# p:abc123:yes              tapping a Yes button (id comes from the proposal)
/morning dan                   run the morning brief now
/evening alina                 run the evening brief now
/midday dan                    run the midday check (usually silent)
/quit
```

Without `LLM_API_KEY` it echoes rather than thinking, which is enough to see the plumbing. Once you have an OpenRouter key (section 5), come back and run it with the key set to hear the real voice. If the tone is wrong, edit `prompts/assistant.core.md` — that is the file that sets it.

---

## 2. One new Gmail account

**The Wall·E inbox**, `wallekaziyev@gmail.com`. One mailbox for everything Wall·E reads in full: school mail, and anything you or Alina forward. It tells the two apart by keyword. Mail with `bisr` anywhere in the sender, subject or body goes down the school pipeline (dates and deadlines proposed to both of you); everything else from you or Alina is answered in the forwarder's chat. The keyword list is `SCHOOL_KEYWORDS`, comma-separated, if the school's domain ever changes.

Two filters to set up in it:

*Filter one — let the right senders through.* Settings → Filters → Create. From: `your@address.com OR alina@address.com OR @bisr.edu.sa` (check the exact school domain on a real BISR email). Action: **Never send it to Spam**.

*Filter two — refuse everyone else.* Create another filter. In the From box put `-{your@address.com alina@address.com @bisr.edu.sa}` (the minus means "not from these"). Action: **Delete it**. That sends anything from anyone else to Trash, where Gmail purges it after 30 days.

That second filter is the door. Wall·E holds no delete permission and cannot bin anything itself, so Gmail does it. Mail that hits Trash is still visible to Wall·E as a sender and a subject line — never a body — and it asks both of you before opening anything. Whoever answers owns it: approve, and the mail is read and answered in their chat, and that sender is remembered as theirs. Say no and it is never raised again. Ignore it and Gmail purges it at 30 days, which is also as far back as Wall·E looks, so nothing is quietly lost if the service is down for a few days.

Finally: share your family Drive folder with the Wall·E account (right-click the folder → Share → paste the address → Editor). Editor rather than Viewer, so the nightly backup can write into it. Note the folder ID from its URL: `drive.google.com/drive/folders/THIS_PART`.

Save the Wall·E address as a contact called Wall·E on both your phones. Forwarding then takes two taps.

---

## 3. Getting school mail into it

Best: give BISR `wallekaziyev@gmail.com` as a parent contact address, so school mail arrives directly.

Until the school updates its records, or as a permanent belt and braces: in whichever account currently receives school mail (yours, Alina's, or the existing school address), Settings → Forwarding → **Add a forwarding address** → the Wall·E address → click the link in the confirmation mail that lands in the Wall·E inbox. Then Settings → Filters → Create → From `@bisr.edu.sa` → **Forward it to** the Wall·E address.

This is what replaced giving Wall·E access to your personal inboxes. No permission is involved. A school mail you forward by hand from your phone works too: it arrives from your address with the school's headers in the body, and the keyword catches it.

---

## 4. Google Cloud and three consents

1. console.cloud.google.com → new project, call it `walle`.
2. APIs & Services → Library → enable **Gmail API**, **Google Calendar API**, **Google Drive API**.
3. OAuth consent screen → **External** → fill the required fields → under Test users add all three addresses (the Wall·E account, yours, Alina's). Leave it in Testing mode; you do not need verification for three accounts you own.
4. Credentials → Create credentials → **OAuth client ID** → application type **Desktop app**. Copy the client ID and secret.

Now run the helper once per account, on your laptop:

```bash
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...

npm run auth -- walle    # sign in as the Wall·E Gmail
npm run auth -- dan      # sign in as your personal Google
npm run auth -- alina    # Alina signs in on her own account
```

Each opens a consent URL, listens on `http://localhost:8765/callback`, and prints one line like `GOOGLE_REFRESH_WALLE=1//0g...`. Keep all three; they go into Railway in section 7.

What each consent screen should say, so you can check nothing is wider than intended:

- **walle** — read your email messages and settings; see and download your Drive files; see and manage files you open or create with this app
- **dan** and **alina** — view and edit events on all your calendars. **If either personal screen mentions Gmail or Drive, stop and tell me.** That would mean the scope table regressed, and there is a test guarding exactly that.

---

## 5. Model and voice keys

**OpenRouter** — openrouter.ai, create a key, add credit. Five dollars is a comfortable month at two users.

Then check the model slug. Open openrouter.ai/models, search DeepSeek, and copy the exact identifier of the current cheap chat tier. The repo defaults to `deepseek/deepseek-chat`, which was right when it was written; slugs move. Whatever you copy becomes `WALLE_MODEL`.

**Groq** — console.groq.com, create a key. This is only for transcribing voice notes.

**Ledger token** — generate one now, it takes a second:

```bash
openssl rand -hex 32
```

That becomes `LEDGER_PUSH_TOKEN`. Nothing uses it until you build the Mac finance pipeline, but the service will not start without it.

---

## 6. Meta: collect credentials, set nothing yet

developers.facebook.com → My Apps → Create App → **Business** → add the **WhatsApp** product.

Collect four things and stop:

- **`META_WA_TOKEN`** — WhatsApp → API Setup. The temporary token there lasts 24 hours; generate a permanent one via Business Settings → Users → System Users → add a system user with admin access to the WhatsApp account → Generate token with `whatsapp_business_messaging` and `whatsapp_business_management`.
- **`META_WA_PHONE_ID`** — the "Phone number ID" on the API Setup page. Not the phone number itself.
- **`META_WABA_ID`** — the "WhatsApp Business Account ID" on the same page.
- **`META_APP_SECRET`** — App Settings → Basic → App secret → Show.

Also add both your and Alina's WhatsApp numbers under "To" on the API Setup page, and verify each with the code that arrives. Those numbers, digits only with country code and no plus (e.g. `9665xxxxxxxx`), become `WA_ID_DAN` and `WA_ID_ALINA`.

**Use the test number for now.** Meta gives you one free, and it can message up to five verified recipients — you need two. That skips the spare SIM, business verification, and the whole registration dance. If Wall·E is still earning its keep at day 28, register the real number then; nothing in the code changes, only `META_WA_PHONE_ID`.

**Do not set the webhook yet.** It needs a URL that does not exist until section 7.

---

## 7. Railway

The service validates its environment at boot and refuses to start if a required variable is missing. That is why credentials come before deployment. The webhook then has to come after, because it needs the deployed URL. Get this order wrong and you will chase your tail.

Everything in the table below is required except `META_WABA_ID` and `WALLE_MODEL_ESCALATED`, which are optional, and `LLM_BASE_URL`, `WALLE_MODEL`, `TZ` and `DATA_DIR`, which have working defaults. Set them all anyway; being explicit costs nothing. One rule worth knowing before it bites: `LEDGER_PUSH_TOKEN` must be at least 16 characters, so a short placeholder will refuse to boot.

1. railway.app → New Project → Deploy from GitHub repo → `d-kazi/walle`.
2. **Attach a volume before the first successful deploy.** Service → Settings → Volumes → New Volume, mount path exactly `/data`. Everything Wall·E remembers lives there; a deploy without it loses the log, the database and the memory files on every restart.
3. Variables → paste all of these:

| Variable | Where it came from |
| --- | --- |
| `META_WA_TOKEN` | section 6, permanent system-user token |
| `META_WA_PHONE_ID` | section 6, Phone number ID |
| `META_WABA_ID` | section 6, WhatsApp Business Account ID |
| `META_APP_SECRET` | section 6, App Settings → Basic |
| `META_WA_VERIFY_TOKEN` | invent one now, any random string; you retype it in section 8 |
| `WA_ID_DAN`, `WA_ID_ALINA` | section 6, digits only, no plus |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_API_KEY` | section 5, OpenRouter |
| `WALLE_MODEL` | section 5, the slug you copied |
| `WALLE_MODEL_ESCALATED` | same slug, or a stronger one for drafting |
| `GROQ_API_KEY` | section 5 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | section 4 |
| `GOOGLE_REFRESH_WALLE`, `GOOGLE_REFRESH_DAN`, `GOOGLE_REFRESH_ALINA` | section 4, the three printed lines |
| `FAMILY_DRIVE_FOLDER_ID` | section 2, from the folder URL |
| `EMAIL_DAN`, `EMAIL_ALINA` | your two personal email addresses; with the school, the only senders the Wall·E inbox accepts |
| `SCHOOL_KEYWORDS` | optional, default `bisr`; comma-separated words that mark school mail |
| `LEDGER_PUSH_TOKEN` | section 5, the openssl output |
| `TZ` | `Asia/Riyadh` |
| `DATA_DIR` | `/data` |

`PORT` is set by Railway; leave it alone.

4. Deploy, then Settings → Networking → Generate Domain.
5. Check it:

```bash
curl https://your-app.up.railway.app/health
```

Read the answer field by field:

- `ok` — true only when the log is writable and the database is open. False means the volume is not mounted at `/data`.
- `eventCount` — 1 on a fresh boot, and it climbs from here.
- `windows` — `{"dan":null,"alina":null}` until each of you has messaged it. This is the 24-hour messaging window; null means only templates can reach that person.
- `template.status` — see section 9. Cached for an hour, so it lags reality after approval.
- `recentErrors` — the last five in 24 hours. Empty is what you want.

If the deploy fails on `better-sqlite3`, check that `.node-version` reached the repo; that file is what keeps the build and the runtime on the same Node major.

---

## 8. Point the webhook at it

Back in the Meta app → WhatsApp → Configuration → Edit:

- **Callback URL**: `https://your-app.up.railway.app/webhook`
- **Verify token**: exactly the `META_WA_VERIFY_TOKEN` you invented
- Verify and save. A 403 means the token does not match, character for character.
- Then **Manage** → subscribe to **messages**. Miss this and the webhook verifies but nothing ever arrives.

Message it from your phone. `/health` should now show a timestamp under `windows.dan`.

---

## 9. Submit the template

Wall·E can only message you freely for 24 hours after you last messaged it. Outside that window it needs a pre-approved template, which is how the 06:30 brief reaches you on a morning when you have not spoken to it since yesterday lunchtime.

WhatsApp Manager → Message templates → Create:

- **Name**: `daily_brief` (exactly, lowercase, underscore)
- **Category**: Utility
- **Language**: English (`en`)
- **Body**: `{{1}}` and nothing else
- **Sample**: paste a realistic brief, e.g. `Morning. Dylan needs his PE kit today, swimming so trunks and towel. The trip form is due Thursday. Alina added: plumber between 2 and 4.`

Approval usually takes minutes to a few hours. `/health` reports `template.status`, which can read:

- `unconfigured (set META_WABA_ID)` — the variable is missing
- `not found` — Meta has not registered the template yet
- `unknown` — the status check itself failed, usually a bad `META_WA_TOKEN`
- `APPROVED` — you are done

**That value is cached for an hour**, so it can keep saying `not found` for up to sixty minutes after Meta has actually approved you. WhatsApp Manager is the faster source of truth; `/health` catches up on its own.

Until it is approved, briefs to a silent user will fail. That is expected, not a bug.

---

## 10. First contact

Both of you message it. Anything: "hello".

Check `/health` shows timestamps under both `windows.dan` and `windows.alina`. Then try the two things that prove the product works:

You: **"tell Alina's brief the plumber comes Thursday between 2 and 4"**
Alina: **"what's on for Dylan this week?"**

---

## 11. Prove it properly

Worth doing deliberately in the first days, in this order.

1. **Say it once, both ways.** You add something shared; it appears in Alina's next brief, attributed, in Wall·E's own words rather than your raw message. Then the same from her to you. Force a brief with `/morning` in the simulator, or just wait for 06:30.
2. **The gift test.** Send: *"remind me to collect Alina's birthday present Thursday, don't mention it to her."* It should go into your private memory. It must never appear in her brief, her chat, or any message to her number. This one is enforced in code, not by the model, and there is a test for it — but check it yourself once.
3. **A real school email.** Wait for one from BISR. It should arrive as a Yes/No/Change proposal to both of you. One tap from Alina and it is in the calendar. Check the event actually exists in Google Calendar.
4. **A forward.** Forward something to the Wall·E address. It should reply in *your* chat, not Alina's — within fifteen minutes during the day, or by the top of the hour if you send it in the evening or overnight (see section 14 for the polling cadence).
5. **A stranger.** Email the Wall·E address from an account that is not yours or Alina's. It should land in Trash, and Wall·E should tell *both* of you the sender and subject and ask before reading it. It must not summarise the contents — if it does, something is wrong and I want to know. Whoever taps Yes owns it: the mail is read and answered in *their* chat, and anything that address sends later goes to the same place. That is what makes a work alias or a second address safe to approve.
6. **A quiet day.** A day with nothing urgent should produce exactly two messages: 06:30 and 21:00. No midday message at all.
7. **Restart.** Redeploy on Railway mid-morning. Message it while it is down. The message should still arrive once it is back, because Meta retries and the log records everything before processing.

---

## 12. The first week

Check `/health` once a day. `recentErrors` is the honest signal; everything else is usually fine.

Run the adoption metric whenever you are curious:

```bash
npm run adoption-report
```

It counts the days each of you messaged it *unprompted* — not a reply within two hours of a brief. That number at day 28 is the only success metric that matters.

Two things are genuinely unproven until real traffic hits them:

**Unmarked memory routing.** The explicit phrases are deterministic and tested — "just for me", "tell Alina's brief", "remember for Dylan", "don't mention it to her" all bypass the model entirely. But an unmarked line like "dentist moved to Tuesday" is the model's judgment call, and DeepSeek is not Claude. Watch for a week. If it misfiles things, tighten the rules in `prompts/assistant.core.md` under Memory routing.

**School extraction.** No fixture can stand in for real BISR mail. Expect the first fortnight to need prompt tuning in `prompts/school-extract.md`. Wrong dates are the failure to watch for.

Both are prompt edits, then redeploy. Neither needs code.

---

## 13. When something breaks

| Symptom | Cause | Fix |
| --- | --- | --- |
| Service will not start, crash loop | A missing environment variable | The Railway log names it. Zod validates all of them at boot and refuses to run half-configured. |
| Webhook verification returns 403 | `META_WA_VERIFY_TOKEN` mismatch | Retype it in both places. No stray spaces. |
| Webhook verifies, nothing arrives | Not subscribed to `messages` | Meta app → WhatsApp → Configuration → Manage → tick `messages`. |
| Repeated 401s in the log | Requests without a valid signature | Check `META_APP_SECRET` is the App secret, not the App ID. |
| Briefs fail, chat replies work | Template not approved yet | Check `template.status` in `/health`. Wait, or message it to reopen the 24-hour window. |
| Build fails on `better-sqlite3` | Node major mismatch between build and runtime | Confirm `.node-version` is in the repo and reads `22`. |
| `/health` shows `ok:false` | Volume not mounted at `/data` | Railway → Settings → Volumes → mount path exactly `/data`, then redeploy. |
| `POST /ledger` returns 401 | Bearer token mismatch | Header must be `Authorization: Bearer <LEDGER_PUSH_TOKEN>` exactly. |
| `POST /ledger` returns 400 | Wrong body shape | Needs `lastSync`, `monthToDate` (object of numbers), optional `notableDeltas`. |
| A forward gets no reply | Sender does not match `EMAIL_DAN`/`EMAIL_ALINA`, or filter two binned it | Check which address you actually forwarded from. Aliases and work accounts count as strangers, by design — you both get asked once, and whoever approves owns that sender from then on. |
| A forward about something unrelated came back as a school proposal | A school keyword appeared in it | Expected: the keyword is deliberately greedy. Decline the proposal. If it keeps happening, narrow `SCHOOL_KEYWORDS` to the school's domain. |
| School mail is being asked about as "looks like school mail in the bin" | Filter one does not include the school's real sending domain | Open a real BISR email, read the exact domain after the @, add it to both filters. Approve the pending one; it is processed as school mail. |
| Nightly backup fails | The Wall·E account cannot create a folder in a folder it does not own | Share the family folder as **Editor**, or transfer ownership to the Wall·E account. Look for `backup_failed` in `recentErrors`. |

---

## 14. Reference

**When things happen**, Asia/Riyadh, every day unless stated:

| Time | What |
| --- | --- |
| 02:00 | Backup to Drive, newest 14 kept |
| 06:30 | Morning brief, both of you |
| every 15 min, 06:00–19:45 | Wall·E inbox polled: school mail and forwards |
| hourly, 20:00–05:00 | Same inbox, overnight cadence |
| 11:00, 11:30, 12:00, 12:30, 13:00, 13:30, 14:00 | Midday check — silent unless something is urgent, max one message each per day |
| 21:00 | Evening brief plus the child-time question |
| 23:30 | Memory curation |
| Sunday 20:00 | Weekly rollup |

**The ledger endpoint**, for when you build the Mac finance pipeline:

```bash
curl -X POST https://your-app.up.railway.app/ledger \
  -H "Authorization: Bearer $LEDGER_PUSH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"lastSync":"2026-08-24T02:00:00+03:00",
       "monthToDate":{"groceries":3200,"school":1500},
       "notableDeltas":["groceries up on last month"]}'
```

Data older than 72 hours is treated as stale: mentioned once in a morning brief, then dropped.

**If the database is ever corrupt**, it is derived, not precious:

```bash
npm run rebuild-db
```

That replays the whole JSONL event log into a fresh database. The log is the truth; the database is a convenience. Nothing is lost as long as `/data/log/` survives, which is what the nightly backup protects.
