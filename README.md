# 🫘 MineBean Auto Deploy Bot v4

Bot deploy otomatis 24/7 di [MineBean](https://minebean.com) — Base Mainnet.
Based on [official skill doc](https://minebean.com/skill.md).

## Features

- ✅ **24/7 mode** — `TOTAL_ROUNDS=0` untuk jalan terus
- ✅ **Smart block selection** — prioritas blok kosong & least crowded
- ✅ **EV calculation** — formula resmi dari skill doc
- ✅ **Auto-claim ETH & BEAN** — setiap N rounds
- ✅ **Roasting strategy** — tahan BEAN untuk bonus or claim
- ✅ **SSE real-time** — terima grid update & round transition live
- ✅ **Auto-reconnect** — SSE reconnect + state recovery
- ✅ **Balance check** — skip round jika saldo kurang
- ✅ **Telegram notifications** — full status report
- ✅ **Railway ready** — SIGTERM handling, graceful shutdown

## Fee Structure

- **1% admin fee** dari total pool
- **~10% vault fee** dari losers pool saja
- **10% roasting fee** pada BEAN claim (unroasted saja)
- Modal minimum: `0.0000025 ETH × jumlah_blok`

## Deploy ke Railway (Recommended)

### 1. Push ke GitHub
```bash
git add .
git commit -m "MineBean Bot v4"
git push origin main
```

### 2. Railway Setup
1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
2. Pilih repo ini
3. Tab **Variables** → paste semua variable (RAW Editor):

```
PRIVATE_KEY=0x...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TOTAL_ROUNDS=0
BLOCKS_PER_DEPLOY=5
ETH_PER_ROUND=0.0000125
BLOCK_STRATEGY=least_crowded
DEPLOY_AT_SECONDS_LEFT=15
CLAIM_EVERY_N_ROUNDS=5
HOLD_BEAN=false
```

4. Bot langsung jalan 24/7! 🚀

### 3. Local (Testing)
```bash
npm install
cp .env.example .env
# Edit .env with your keys
npm start
```

## Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `PRIVATE_KEY` | **wajib** | Private key wallet |
| `TELEGRAM_BOT_TOKEN` | opsional | Token bot Telegram |
| `TELEGRAM_CHAT_ID` | opsional | Chat ID kamu |
| `TOTAL_ROUNDS` | `0` | 0 = unlimited 24/7 |
| `BLOCKS_PER_DEPLOY` | `5` | Blok per round (1-25) |
| `ETH_PER_ROUND` | `0.0000125` | ETH per round |
| `BLOCK_STRATEGY` | `least_crowded` | `least_crowded` atau `random` |
| `DEPLOY_AT_SECONDS_LEFT` | `15` | Deploy X detik sebelum habis |
| `CLAIM_EVERY_N_ROUNDS` | `5` | Claim ETH/BEAN tiap N rounds |
| `CLAIM_ETH_MIN` | `0.0005` | Min ETH pending untuk claim |
| `CLAIM_BEAN_MIN` | `1.0` | Min BEAN pending untuk claim |
| `HOLD_BEAN` | `false` | `true` = tahan BEAN (roasting bonus) |
| `MIN_BALANCE_ETH` | `0.0005` | Min saldo ETH |
| `BASE_RPC_URL` | `https://mainnet.base.org` | RPC URL |

## Strategi

### Block Selection
- **least_crowded**: Pilih blok dengan miner paling sedikit → share reward lebih besar jika menang
- **random**: Pilih blok acak

### BEAN Management
- **HOLD_BEAN=true**: Tahan BEAN → dapat passive roasting bonus (10% dari claim orang lain)
- **HOLD_BEAN=false**: Claim BEAN reguler, lalu stake manual di minebean.com

### EV Formula (dari skill doc)
```
Net EV = BEAN_value + Beanpot_EV − House_cost
BEAN_value = 1 BEAN × priceNative
Beanpot_EV = (1/777) × beanpotPool × priceNative  
House_cost = ETH_deployed × 0.11
```

## Catatan

- Gunakan **wallet dedicated**, bukan wallet utama
- Base RPC publik kadang lambat — pakai Alchemy/Infura untuk Railway
- BEAN bisa di-stake di minebean.com untuk yield dari treasury buybacks
- Beanpot jackpot: ~0.13% chance per round, pool terus tumbuh
