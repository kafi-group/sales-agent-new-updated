# Kafi Bulk / Individual Mailer (Vercel)

Separate email UI deployed on **Vercel** (not Railway). Railway Hobby blocks SMTP;
Vercel allows outbound SMTP on ports 465/587. The Sales Agent opens this app when you
click **Send emails**.

## Architecture

```
Sales Agent Mail click
  → POST /api/mailer/session → mailer /auth/callback?code=…
  → full Mail UI (inbox/sent/drafts/trash/archive/templates)

Sales Agent Send emails
  → POST /api/mailer/handoff → mailer /bulk?token=…
  → batch SMTP on Vercel (+ session login from handoff)

Mailer reads IMAP via Railway /api/inbox/*
Mailer sends only via /api/send and /api/send-batch (Vercel SMTP)
Mailer reports each send to Railway POST /api/mailer/report-activity
  → Email Activity + Insights ONLY in Sales Agent Mail (not in mailer UI)
Mailer asks Railway POST /api/mailer/append-sent after SMTP success
  → IMAP APPEND into Sent (cPanel SMTP does not auto-save)
```

## What you must provide

1. Create a **second Vercel project** pointed at this `mailer/` directory (Root Directory = `mailer`).
2. Env vars on that Vercel project:

```
MAILER_HANDOFF_SECRET=<long random string, same as Railway>
KAFI_API_BASE_URL=https://YOUR-RAILWAY-HOST/api
NEXT_PUBLIC_KAFI_API_BASE_URL=https://YOUR-RAILWAY-HOST/api
MAILBOX_SMTP_HOST=67.23.252.42
MAILBOX_SMTP_PORT=465
MAILBOX_SSL_HOSTNAME=mail.kafi-group.com
MAILBOX_ADMIN_EMAIL=...
MAILBOX_ADMIN_PASSWORD=...
# (+ other MAILBOX_* users)
```

3. On **Railway** (Sales Agent backend):

```
MAILER_HANDOFF_SECRET=<same secret>
MAILER_PUBLIC_URL=https://YOUR-MAILER.vercel.app
```

4. Sales Agent **Mail** nav opens `/auth/callback?code=…` (session exchange).
   Leads **Send emails** opens `/bulk?token=…`.

## Batch defaults

- Batch size: 10 emails per API call  
- Pause between batches: 45 seconds  
- Delay between messages inside a batch: 2 seconds  

Adjust in the mailer UI before sending.
