# Mainnet: собрать деньги, закрыть старую программу, развернуть новую и запустить Test 2 (дев = 0)

Решение Романа (2026-10-03): Test 1 не нужен, старая программа `FG7Y…` закрывается, новая развёртывается на **новом адресе**.
Новая программа: **`3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD`** (ключ — `target/deploy/onchain_state_solana-keypair.json`). Старый ключ `FG7Y…` сохранён в `~/FG7Y-program-keypair.OLD.json`.
Решение Романа (2026-10-04): разворачиваем и запускаем с **НОВОГО кошелька** (дальше `$NEW`): на него собираем всё, что можно вернуть из Test 1, и на него же приходит залог за закрытую старую программу.
Все команды ниже запускает Роман в своём терминале; Claude готовит скрипты, проверяет каждый шаг по сети и сверяет цифры. Каждый скрипт без подтверждения только печатает план.

Каждый шаг был прогнан на локальной копии (закрыть → буфер → загрузка → развёртывание → полный e2e) и на devnet с новым адресом; на mainnet ничего ещё не запускалось.
Закрытие программы с отдельным получателем (`RECIPIENT`) и `send_sol.ts` проверены на локальном валидаторе 2026-10-04.

## Деньги: что можно вернуть и что нужно (измерено по сети 2026-10-04, SOL)
| Откуда | Сколько | Примечание |
|---|---|---|
| залог старой программы `FG7Y…` (закрытие) | **2,4743** | необратимо; идёт сразу на `$NEW` |
| кошелёк A7mn… (деплоер Test 1) | 0,0673 | выметаем ПОСЛЕ закрытия (он платит комиссию закрытия) |
| LP-кошелёк `FMay5…` | 0,9663 | деньги Никиты (он слал 0,6; осталось 0,966 после опыта) — переводить только с его согласия |
| **итого можно собрать** | **3,5079** | |
| Нужно новой программе | ≈2,654 | залог 2,6501 + аккаунт программы 0,0008 + комиссии 0,003; временный буфер 2,6501 вернётся при развёртывании |
| Нужно на запуск Test 2 | ≈0,03–0,05 | замер на devnet ≈0,03 |
| **Останется** | **≈0,8** | на покупки команды |

Без денег LP-кошелька: 2,5416 → не хватает ≈0,17 (на программу и запуск) — тогда докинуть 0,2 SOL.
Не стоит возвращать: в пуле Test 1 лежит всего 0,0176 SOL (достать можно только продажей монет в пул — ≈0,017 SOL, роняет цену Test 1); аренда пустых счетов монет по 0,0015 SOL; Config/казна Test 1 ≈0,0066 SOL останутся в закрытой программе навсегда.

## 0. До начала (один раз)
1. **Новый кошелёк.** Если его ещё нет — создать файл-ключ (напечатает адрес и 12 слов: слова записать на бумагу, файл скопировать вне компьютера):
```bash
solana-keygen new --no-bip39-passphrase --outfile ~/deployer-mainnet.json
solana-keygen pubkey ~/deployer-mainnet.json        # адрес нового кошелька — его (публичный) можно присылать мне
```
2. **Копии ключей вне компьютера** (флешка / менеджер паролей): `~/deployer-mainnet.json` (НОВЫЙ кошелёк — он же upgrade authority новой программы), `target/deploy/onchain_state_solana-keypair.json` (ключ новой программы), `~/.config/solana/id.json` (`A7mn…`), `~/FG7Y-program-keypair.OLD.json`, `~/lp-wallet.json`.
3. **RPC:** публичный mainnet режет запросы. Возьмите свой Helius-ключ из переписки и положите в переменную (не в файл, не в чат):
```bash
cd /Users/romantalanin/Desktop/onchain-state-solana-main
export ANCHOR_PROVIDER_URL="https://mainnet.helius-rpc.com/?api-key=<КЛЮЧ>"
export HTTP_CONFIRM=1
export NEW=<адрес нового кошелька>
```

## 1. Собрать деньги на новый кошелёк и закрыть старую программу (закрытие НЕОБРАТИМО)
```bash
# 1a. (только с согласия Никиты) весь SOL с LP-кошелька -> новый кошелёк
KEYPAIR=~/lp-wallet.json TO=$NEW AMOUNT=all npx ts-node scripts/send_sol.ts              # план: «afterwards: sender 0 SOL, recipient ≈0.966 SOL»
KEYPAIR=~/lp-wallet.json TO=$NEW AMOUNT=all CONFIRM=yes npx ts-node scripts/send_sol.ts

# 1b. закрыть старую программу, залог -> новый кошелёк (подписывает и платит комиссию A7mn — он upgrade authority старой)
ANCHOR_WALLET=~/.config/solana/id.json PROGRAM_ID=FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy RECIPIENT=$NEW npx ts-node scripts/close_program.ts
#   план: «= your wallet» и «deposit returned ≈2.474 SOL -> <адрес $NEW>» — сверить адрес получателя!
ANCHOR_WALLET=~/.config/solana/id.json PROGRAM_ID=FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy RECIPIENT=$NEW CONFIRM_CLOSE=FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy npx ts-node scripts/close_program.ts

# 1c. остаток с A7mn -> новый кошелёк (последним: до этого A7mn нужен для комиссии закрытия)
KEYPAIR=~/.config/solana/id.json TO=$NEW AMOUNT=all npx ts-node scripts/send_sol.ts
KEYPAIR=~/.config/solana/id.json TO=$NEW AMOUNT=all CONFIRM=yes npx ts-node scripts/send_sol.ts
```
После этого `FG7Y…` на mainnet мёртв навсегда; пул/казна Test 1 остаются без управления (там копейки). Присылайте мне вывод — я сверю баланс `$NEW` по сети (должно быть ≈3,50 SOL с деньгами LP-кошелька или ≈2,54 без них).

## 2. Новая программа (всё с НОВОГО кошелька)
```bash
export ANCHOR_WALLET=~/deployer-mainnet.json
export PROGRAM_ID=3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD
export BUFFER_KEYPAIR=~/mainnet-buffer-NEW.json
CONFIRM=yes npx ts-node scripts/make_buffer.ts                    # создаёт буфер (≈2,65 SOL залога, вернутся сами); СКОПИРУЙТЕ ~/mainnet-buffer-NEW.json
# загрузка 580 кусков: три потока одновременно (больше трёх публичный RPC режет), каждый в своём окне терминала
# (в каждом окне сначала повторить export-строки выше: ANCHOR_PROVIDER_URL, HTTP_CONFIRM, ANCHOR_WALLET, PROGRAM_ID, BUFFER_KEYPAIR):
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
Нужно от Никиты: **название, символ, ссылка на картинку/метаданные (URI), START_FDV (оценка всего выпуска в SOL на старте), во сколько стартуют торги (START_IN_SECS)**, адреса owner/admin/президента (по умолчанию все = новый кошелёк `$NEW`).
```bash
export GOVERNANCE_MINT=<адрес, который напечатает create_mint>
OUT=~/test2-mint-mainnet.json NAME="Test 2" SYMBOL=TEST2 URI=<ссылка> INITIAL_SUPPLY=1000000000 npx ts-node scripts/create_mint.ts
OWNERS_AUTHORITY=<owner> ADMIN_AUTHORITY=<admin> PRESIDENT=<президент> PARAMS=prod npx ts-node scripts/initialize.ts     # PARAMS=test на mainnet запрещён
npx ts-node scripts/setup_milestone_fund.ts
POOL_OUT=~/test2-pool-mainnet.json SINGLE_SIDED=1 TOKEN_AMOUNT=all START_FDV=<SOL> START_IN_SECS=<сек> npx ts-node scripts/create_pool.ts
POOL_OUT=~/test2-pool-mainnet.json npx ts-node scripts/register_pool.ts
ALSO_METADATA=yes CONFIRM=yes npx ts-node scripts/revoke_mint_authority.ts                   # необратимо: больше нельзя печатать монеты и менять имя/картинку
DEV=$NEW npx ts-node scripts/launch_check.ts                                                 # должно быть «ALL PASS» (11 из 11)
```
Дальше команда выкупает монеты из пула (покупка на сайте Meteora или `pool_swap.ts`), сбор комиссии в казну — `claim_pool_fees.ts`, отчёт — `pool_report.ts`. Стоимость выкупа доли f выпуска ≈ START_FDV·f/(1−f) (+5% комиссии: 1% уходит Meteora, 4% — в казну проекта).
