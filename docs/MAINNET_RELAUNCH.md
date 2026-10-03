# Mainnet: закрыть старую программу, развернуть новую и запустить Test 2 (дев = 0)

Решение Романа (2026-10-03): Test 1 не нужен, старая программа `FG7Y…` закрывается, новая развёртывается на **новом адресе**.
Новая программа: **`3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD`** (ключ — `target/deploy/onchain_state_solana-keypair.json`). Старый ключ `FG7Y…` сохранён в `~/FG7Y-program-keypair.OLD.json`.
Все команды ниже запускает Роман в своём терминале; Claude готовит скрипты, проверяет каждый шаг по сети и сверяет цифры. Каждый скрипт без подтверждения только печатает план.

Каждый шаг был прогнан на локальной копии (закрыть → буфер → загрузка → развёртывание → полный e2e) и на devnet с новым адресом; на mainnet ничего ещё не запускалось.

## 0. До начала (один раз)
1. **Копии ключей вне компьютера** (флешка / менеджер паролей): `target/deploy/onchain_state_solana-keypair.json` (НОВЫЙ ключ программы — теперь боевой), `~/.config/solana/id.json` (`A7mn…`, он же upgrade authority), `~/FG7Y-program-keypair.OLD.json`.
2. **RPC:** публичный mainnet режет запросы. Возьмите свой Helius-ключ из переписки и положите в переменную (не в файл, не в чат):
```bash
cd /Users/romantalanin/Desktop/onchain-state-solana-main
export ANCHOR_PROVIDER_URL="https://mainnet.helius-rpc.com/?api-key=<КЛЮЧ>"
export ANCHOR_WALLET=~/.config/solana/id.json
export HTTP_CONFIRM=1
```
3. **Деньги.** Сейчас на `A7mn…` ≈0,067 SOL. Закрытие старой программы вернёт ≈2,474 SOL → станет ≈2,54. Новой нужно ≈2,650 (залог) + ≈0,02 комиссий → **пополните `A7mn…` минимум на 0,2 SOL, лучше на 0,5** (ещё нужно на запуск Test 2 ≈0,05 и покупки команды).

## 1. Закрыть старую программу (НЕОБРАТИМО)
```bash
PROGRAM_ID=FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy npx ts-node scripts/close_program.ts            # план: должно быть «= your wallet» и «deposit returned ≈2.474 SOL»
PROGRAM_ID=FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy CONFIRM_CLOSE=FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy npx ts-node scripts/close_program.ts
```
После этого `FG7Y…` мёртв навсегда; пул/казна Test 1 остаются без управления (там копейки).

## 2. Новая программа
```bash
export PROGRAM_ID=3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD
export BUFFER_KEYPAIR=~/mainnet-buffer-NEW.json
CONFIRM=yes npx ts-node scripts/make_buffer.ts                    # создаёт буфер (≈2,65 SOL залога, вернутся сами); СКОПИРУЙТЕ ~/mainnet-buffer-NEW.json
# загрузка 580 кусков: три потока одновременно (больше трёх публичный RPC режет), каждый в своём окне терминала:
WORKER=0/3 npx ts-node scripts/upgrade_program.ts
WORKER=1/3 npx ts-node scripts/upgrade_program.ts
WORKER=2/3 npx ts-node scripts/upgrade_program.ts
# когда все три напишут «done»: проверка байт в байт (БЕЗ --upgrade)
npx ts-node scripts/upgrade_program.ts                            # должно быть: «buffer identical to the .so: true»
npx ts-node scripts/deploy_new_program.ts                         # план: адрес 3cbH…, «byte-identical: true», «authority = payer»
CONFIRM=yes npx ts-node scripts/deploy_new_program.ts
```
Если что-то оборвалось — повторите ту же команду (всё возобновляется). Присылайте мне вывод каждого шага: я сверяю по сети (байты программы должны совпасть с `target/deploy/onchain_state_solana.so`, sha256 начинается с `eae9b9ea`).

## 3. Test 2: запуск «дев = 0»
Нужно от Никиты: **название, символ, ссылка на картинку/метаданные (URI), START_FDV (оценка всего выпуска в SOL на старте), во сколько стартуют торги (START_IN_SECS)**, адреса owner/admin/президента (по умолчанию все `A7mn…`).
```bash
export GOVERNANCE_MINT=<адрес, который напечатает create_mint>
OUT=~/test2-mint-mainnet.json NAME="Test 2" SYMBOL=TEST2 URI=<ссылка> INITIAL_SUPPLY=1000000000 npx ts-node scripts/create_mint.ts
OWNERS_AUTHORITY=<owner> ADMIN_AUTHORITY=<admin> PRESIDENT=<президент> PARAMS=prod npx ts-node scripts/initialize.ts     # PARAMS=test на mainnet запрещён
npx ts-node scripts/setup_milestone_fund.ts
POOL_OUT=~/test2-pool-mainnet.json SINGLE_SIDED=1 TOKEN_AMOUNT=all START_FDV=<SOL> START_IN_SECS=<сек> npx ts-node scripts/create_pool.ts
POOL_OUT=~/test2-pool-mainnet.json npx ts-node scripts/register_pool.ts
ALSO_METADATA=yes CONFIRM=yes npx ts-node scripts/revoke_mint_authority.ts                   # необратимо: больше нельзя печатать монеты и менять имя/картинку
DEV=<адрес создателя> npx ts-node scripts/launch_check.ts                                    # должно быть «ALL PASS» (11 из 11)
```
Дальше команда выкупает монеты из пула (покупка на сайте Meteora или `pool_swap.ts`), сбор комиссии в казну — `claim_pool_fees.ts`, отчёт — `pool_report.ts`. Стоимость выкупа доли f выпуска ≈ START_FDV·f/(1−f) (+5% комиссии: 1% уходит Meteora, 4% — в казну проекта).
