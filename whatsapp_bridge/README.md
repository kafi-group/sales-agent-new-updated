# Kafi WhatsApp Mobile Bridge (Baileys)

Microservice for **one Sales Agent user's** personal WhatsApp Mobile session via `@whiskeysockets/baileys`.

> **Do not confuse** with Railway project **Whatsapp for Costing New** (Finance / PA). That is a separate stack.

## Multi-user isolation (Railway Pro)

Sales Agent uses **four separate Railway projects** so one disconnect never affects the others:

| User | Railway project | Default bridge URL |
|------|-----------------|--------------------|
| Khalid / Admin | Sales Agent WhatsApp - Khalid | `whatsapp-bridge-production-ffd3…` |
| Asim | Sales Agent WhatsApp - Asim | `whatsapp-bridge-production-8eee…` |
| Usman | Sales Agent WhatsApp - Usman | `whatsapp-bridge-production-9587…` |
| Sadia | Sales Agent WhatsApp - Sadia | `whatsapp-bridge-production-8388…` |

Backend maps each login to its own URL (`WHATSAPP_BRIDGE_URL_KHALID` / `_ASIM` / `_USMAN` / `_SADIA`).  
Session folders are namespaced: `kafi-sales-agent-<username>` — disconnect/delete only that folder.

## Required: persistent volume (keeps QR linked across redeploys)

Without a volume, Railway wipes the container disk on redeploy → phone shows “last active …” and Sales Agent asks for QR again.

On **each** of the four Sales WhatsApp bridge services:

1. Railway → service → **Volumes** → Add volume  
2. Mount path: `/data`  
3. Optional env: `WHATSAPP_SESSIONS_DIR=/data/whatsapp-sessions` (auto-used if `/data` exists)

Sessions are restored automatically on boot from saved `creds.json`.

## Env vars (per bridge service)

- `WHATSAPP_BRIDGE_SECRET` — same as Sales Agent backend  
- `BACKEND_WEBHOOK_URL` — `https://kafi-sales-agent-production.up.railway.app`  
- `PORT` — Railway default / `3001`

## Sales Agent backend env

```
WHATSAPP_BRIDGE_SECRET=…
WHATSAPP_BRIDGE_URL_KHALID=https://whatsapp-bridge-production-ffd3.up.railway.app
WHATSAPP_BRIDGE_URL_ASIM=https://whatsapp-bridge-production-8eee.up.railway.app
WHATSAPP_BRIDGE_URL_USMAN=https://whatsapp-bridge-production-9587.up.railway.app
WHATSAPP_BRIDGE_URL_SADIA=https://whatsapp-bridge-production-8388.up.railway.app
```

## Behaviour

- Stay connected until **Disconnect** in Sales Agent or unlink on the phone  
- Soft pair restores session; `forceNew` only for intentional fresh QR  
- Asim disconnect ≠ Khalid / Usman / Sadia
