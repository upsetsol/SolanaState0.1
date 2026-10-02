# Тест: добавить свою (не заблокированную) ликвидность в боевой пул Test 1 и увидеть, куда уходит комиссия

Монета `GFCg1WqNBHwRHHaw5eXH2SioKTpuqjcCn8tznxPunvSZ`, пул `3BKVYcJgqmzHRQCg3NgifEC77hQLczyZ8kmZyvwMwREb` (mainnet). Контракт не трогаем: это отдельная позиция в пуле Meteora, её можно забрать целиком.
Репетиция на локальной копии пула прошла (`audit/lp_tools_check.ts`). Каждый скрипт без `CONFIRM=yes` только печатает план («dry run»), ничего не отправляя.

## 0. Один раз в терминале
```bash
cd /Users/romantalanin/Desktop/onchain-state-solana-main
export GOVERNANCE_MINT=GFCg1WqNBHwRHHaw5eXH2SioKTpuqjcCn8tznxPunvSZ
export ANCHOR_PROVIDER_URL=<надёжный RPC mainnet, например Helius>
export ANCHOR_WALLET=~/.config/solana/id.json
```
## 1. Новый кошелёк под ликвидность (ключ хранить у себя, никому не слать)
```bash
solana-keygen new --no-bip39-passphrase -o ~/lp-wallet.json
solana address -k ~/lp-wallet.json          # это адрес, на который Никита шлёт SOL (≈0,6 SOL для вклада 0,5)
```
## 2. Монеты на этот кошелёк (с `A7mn…`; на 0,5 SOL нужно ≈19 млн, шлём 20 млн)
```bash
KEYPAIR=~/.config/solana/id.json TO=<адрес из шага 1> AMOUNT=20000000 npx ts-node scripts/send_coins.ts            # план
KEYPAIR=~/.config/solana/id.json TO=<адрес из шага 1> AMOUNT=20000000 CONFIRM=yes npx ts-node scripts/send_coins.ts
```
## 3. Начать с чистого листа: забрать накопленную комиссию в казну (может любой) и снять «снимок» отчёта
```bash
KEYPAIR=~/lp-wallet.json npx ts-node scripts/claim_pool_fees.ts
LP_WALLET=<адрес из шага 1> REPORT_OUT=~/before.json npx ts-node scripts/pool_report.ts
```
## 4. Добавить ликвидность (0,5 SOL)
```bash
KEYPAIR=~/lp-wallet.json SOL_AMOUNT=0.5 npx ts-node scripts/add_liquidity.ts                  # план: сколько монет, какая доля пула
KEYPAIR=~/lp-wallet.json SOL_AMOUNT=0.5 CONFIRM=yes npx ts-node scripts/add_liquidity.ts
```
Ожидаемо: доля новой позиции ≈ 95,6 %, у казны остаётся ≈ 4,4 %.
## 5. Покупка Никиты (например 0,05 SOL) — любым способом: сайт Meteora со своего кошелька или скриптом с отдельного кошелька
```bash
KEYPAIR=<кошелёк покупателя> SIDE=buy AMOUNT=0.05 npx ts-node scripts/pool_swap.ts
```
## 6. Посмотреть, куда ушло
```bash
LP_WALLET=<адрес из шага 1> REPORT_PREV=~/before.json npx ts-node scripts/pool_report.ts
```
Покажет: комиссия Meteora (20 %), доля казны и доля вашей позиции (80 % комиссии делятся по долям). Казне деньги приходят после `claim_pool_fees` (шаг 3, любой может вызвать).
## 7. Забрать всё обратно (когда насмотрелись)
```bash
KEYPAIR=~/lp-wallet.json npx ts-node scripts/remove_liquidity.ts                              # план
KEYPAIR=~/lp-wallet.json CONFIRM=yes npx ts-node scripts/remove_liquidity.ts
```
Вернутся SOL и монеты (после покупок SOL будет чуть больше, монет чуть меньше) плюс заработанная комиссия; позиция закрывается, залог за неё возвращается.
