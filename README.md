# 🫘 MineBean Auto Deploy Bot

Bot deploy otomatis tiap round di [MineBean](https://minebean.com) — Base Mainnet.

## Kenapa modal kecil?

Fee struktur MineBean sangat kecil:
- **1% admin fee** dari total pool
- **~10% vault fee** dari losers pool SAJA (bukan dari modal kamu)
- Tujuan utama = **dapat 1 BEAN per round**, bukan profit dari ETH

Modal minimum hanya `0.0000025 ETH × jumlah_blok`:
- 5 blok = **0.0000125 ETH/round** (~$0.00003)
- 10 blok = **0.000025 ETH/round** (~$0.00006)

## Setup

### 1. Isi .env

Rename `.env.example` → `.env`, lalu isi:

```
PRIVATE_KEY=0x...
TELEGRAM_BOT_TOKEN=...   ← dari @BotFather
TELEGRAM_CHAT_ID=...     ← dari @userinfobot
TOTAL_ROUNDS=10
ETH_PER_ROUND=0.0000125
```

### 2. Deploy ke Railway

1. Push ke GitHub (`.env` JANGAN ikut — sudah ada di .gitignore)
2. Railway → **New Project → Deploy from GitHub**
3. Di tab **Variables**, paste semua isi `.env` kamu (pakai RAW Editor)
4. Bot langsung jalan!

### 3. Local

```bash
npm install
npm start
```

## Notif Telegram

```
🤖 AUTO-MINER STARTED! (10 rounds)   ← saat bot start
🎯 AUTO-MINER RUNNING                 ← sebelum deploy
✅ Round 1/10 completed               ← setelah TX confirm
   Deployed: Blocks [14, 15, 16, 17, 18]
   TX: 0x1f41...6454e
   ⏳ Waiting for next round (~60s)...
💰 ETH Claimed                        ← tiap N rounds
📊 Status Report                      ← PnL, BEAN pending
🏁 AUTO-MINER SELESAI!                ← akhir session
```

## .env lengkap

| Variable | Default | Keterangan |
|---|---|---|
| `PRIVATE_KEY` | **wajib** | Private key wallet |
| `TELEGRAM_BOT_TOKEN` | **wajib** | Token bot Telegram |
| `TELEGRAM_CHAT_ID` | **wajib** | Chat ID kamu |
| `TOTAL_ROUNDS` | `10` | Berapa round dijalankan |
| `BLOCKS_PER_DEPLOY` | `5` | Blok per round |
| `ETH_PER_ROUND` | `0.0000125` | ETH per round (min 0.0000025 × blok) |
| `BLOCK_STRATEGY` | `least_crowded` | `least_crowded` atau `random` |
| `DEPLOY_AT_SECONDS_LEFT` | `15` | Deploy X detik sebelum round habis |
| `CLAIM_EVERY_N_ROUNDS` | `5` | Claim ETH tiap N rounds |
| `CLAIM_ETH_MIN` | `0.0005` | Min ETH pending untuk claim |

## Catatan

- **BEAN tidak di-stake otomatis** — ada di wallet, klaim manual di minebean.com kapanpun
- Gunakan wallet dedicated, bukan wallet utama
- Base RPC publik kadang lambat — pakai Alchemy/Infura untuk lebih stabil
