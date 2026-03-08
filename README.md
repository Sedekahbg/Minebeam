# 🫘 MineBean Manual Deploy Bot

Bot manual deploy tiap round — **no auto-stake**, BEAN reward tetap di wallet buat kamu ambil sendiri.

## Fitur
- ✅ Deploy manual tiap round (bukan AutoMiner contract)
- ✅ Pilih blok paling sepi otomatis (`least_crowded`) atau random
- ✅ Deploy reaktif — masuk di detik ke-45 (15s sebelum round habis)
- ✅ EV calculator — skip deploy kalau EV negatif
- ✅ Auto claim ETH setiap N rounds
- ✅ Notifikasi Telegram per round (deployed, TX, status)
- ❌ **No auto-stake** — BEAN tinggal kamu klaim manual kapanpun

---

## Deploy ke Railway

### 1. Push ke GitHub
```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/USER/minebean-bot.git
git push -u origin main
```

### 2. Railway
1. **New Project → Deploy from GitHub**
2. Pilih repo → Railway auto-detect Node.js & jalankan `npm start`
3. Set **Variables**:

| Variable | Contoh | Keterangan |
|---|---|---|
| `PRIVATE_KEY` | `0x...` | Private key wallet |
| `TELEGRAM_BOT_TOKEN` | `123:ABC...` | Dari @BotFather |
| `TELEGRAM_CHAT_ID` | `987654321` | Chat ID kamu |
| `TOTAL_ROUNDS` | `10` | Berapa round mau jalan |
| `BLOCKS_PER_DEPLOY` | `5` | Blok per deploy |
| `ETH_PER_ROUND` | `0.001` | ETH per round |
| `BLOCK_STRATEGY` | `least_crowded` | atau `random` |
| `DEPLOY_AT_SECONDS_REMAINING` | `15` | Deploy 15s sebelum round habis |
| `CLAIM_EVERY_N_ROUNDS` | `5` | Claim ETH tiap 5 round |
| `CLAIM_ETH_MIN` | `0.0005` | Min pending ETH untuk claim |
| `EV_CHECK_ENABLED` | `true` | Skip deploy kalau EV negatif |

---

## Local Dev
```bash
cp .env.example .env   # isi nilai-nilainya
npm install
npm start
```

---

## Alur Bot

```
Start
  → Cek balance & network
  → Kirim notif Telegram "AUTO-MINER STARTED"
  → Deploy di round saat ini kalau waktu cukup

Tiap round (SSE roundTransition):
  → Tunggu sampai X detik sebelum round habis
  → Fetch grid → pilih blok sepi
  → Cek EV → skip kalau negatif
  → deploy() dengan ETH
  → Kirim notif TX

Tiap N rounds:
  → claimETH() kalau pending > threshold
  → Kirim status report (PnL, rounds, balance)

Selesai (TOTAL_ROUNDS tercapai):
  → claimETH() final
  → Status report final
  → Notif "SELESAI" — BEAN masih di wallet, klaim sendiri kapanpun
```

## Catatan

- **BEAN tidak di-stake otomatis** — klaim via [minebean.com](https://minebean.com) atau langsung call `claimBEAN()` di contract
- Gunakan wallet dedicated, jangan wallet utama
- Pastikan ETH cukup: `ETH_PER_ROUND × TOTAL_ROUNDS × 1.05` (buffer gas)
