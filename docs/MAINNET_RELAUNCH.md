# Mainnet: собрать деньги, закрыть старую программу, развернуть новую и запустить Test 2 (дев = 0)

Решение Романа (2026-10-03): Test 1 не нужен, старая программа `FG7Y…` закрывается, новая развёртывается на **новом адресе**.
Новая программа: **`3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD`** (ключ — `target/deploy/onchain_state_solana-keypair.json`). Старый ключ `FG7Y…` сохранён в `~/FG7Y-program-keypair.OLD.json`.
Решение Романа (2026-10-04): разворачиваем и запускаем с **НОВОГО кошелька** (дальше `$NEW`): на него собираем всё, что можно вернуть из Test 1, и на него же приходит залог за закрытую старую программу.
Новый кошелёк создан 2026-10-04: адрес **`4pjGakyrTCMzuebbdeUyNesFqJZ5SeaHthmaUAAwv3mz`**, ключ `~/deployer-mainnet.json`; копии всех пяти ключей — в папке `~/KEYS-BACKUP-onchain-state/` (её нужно скопировать на флешку или по AirDrop на iPhone). Роман разрешил: 0,966 SOL с LP-кошелька (деньги Никиты, согласие получено) переводим на новый кошелёк; Helius-ключ не обязателен (как и в devnet-репетиции — на публичном RPC бывают обрывы, но всё возобновляется).
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
1. **Новый кошелёк — создан** (`4pjGakyrTCMzuebbdeUyNesFqJZ5SeaHthmaUAAwv3mz`, файл `~/deployer-mainnet.json`, без seed-фразы — сам файл и есть ключ). Если когда-нибудь понадобится новый: `solana-keygen new --no-bip39-passphrase --silent --outfile ~/<имя>.json`, адрес — `solana-keygen pubkey ~/<имя>.json`.
2. **Копии ключей вне компьютера** (флешка / менеджер паролей): `~/deployer-mainnet.json` (НОВЫЙ кошелёк — он же upgrade authority новой программы), `target/deploy/onchain_state_solana-keypair.json` (ключ новой программы), `~/.config/solana/id.json` (`A7mn…`), `~/FG7Y-program-keypair.OLD.json`, `~/lp-wallet.json`.
3. **RPC:** публичный mainnet режет запросы. Возьмите свой Helius-ключ из переписки и положите в переменную (не в файл, не в чат):
```bash
cd /Users/romantalanin/Desktop/onchain-state-solana-main
export ANCHOR_PROVIDER_URL="https://mainnet.helius-rpc.com/?api-key=<КЛЮЧ>"
export HTTP_CONFIRM=1
export NEW=4pjGakyrTCMzuebbdeUyNesFqJZ5SeaHthmaUAAwv3mz
```

## 1. Собрать деньги на новый кошелёк и закрыть старую программу (закрытие НЕОБРАТИМО) — ВЫПОЛНЕНО 2026-10-04
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

## 2. Новая программа (всё с НОВОГО кошелька) — одной командой
Состояние на 2026-10-04 (проверено по сети): шаги 1a–1c ВЫПОЛНЕНЫ (tx `3Ecrp14g…`, `4nNE28ff…`, `4qYzi3mZ…`, все finalized), на новом кошельке 3,5079 SOL, `FG7Y…` закрыта, `3cbH…` ещё не развёрнута.
```bash
cd /Users/romantalanin/Desktop/onchain-state-solana-main && CONFIRM=yes caffeinate -i npx ts-node scripts/deploy_mainnet.ts
```
Что делает `scripts/deploy_mainnet.ts` (по умолчанию: публичный mainnet RPC, кошелёк `~/deployer-mainnet.json`, буфер `~/mainnet-buffer-NEW.json`): проверяет сборку (sha256 `eae9b9ea…`), ключ программы и баланс (нужно ≈2,671 SOL) → создаёт буфер (≈2,650 SOL, вернутся) → загружает 580 кусков тремя потоками (10–30 минут на публичном RPC) → сверяет побайтно → разворачивает → читает программу из сети и сверяет с сборкой, upgrade authority должен быть новый кошелёк.
Без `CONFIRM=yes` только проверяет и печатает план. **Можно запускать повторно после любого обрыва** (закрыли терминал, ошибки RPC): готовые шаги пропускаются, буфер переиспользуется (ключ буфера сохраняется ДО отправки транзакции), недостающие куски дописываются. Если публичный RPC душит — `WORKERS=2`, либо свой `ANCHOR_PROVIDER_URL` (Helius).
Проверено на локальном валидаторе 2026-10-04: полный прогон (145 с), повторный запуск после успеха («already deployed»), убийство посреди загрузки и продолжение (355 из 580 кусков дописано, развёрнуто и сверено), отказ при чужой сборке/нехватке SOL, `make_buffer` с существующим ключом/чужим аккаунтом.
Ручной вариант (то же по шагам): `make_buffer.ts` → `WORKER=0/3,1/3,2/3 upgrade_program.ts` (в трёх окнах) → `upgrade_program.ts` без WORKER (проверка «identical: true») → `deploy_new_program.ts` с `CONFIRM=yes`; переменные: `ANCHOR_WALLET=~/deployer-mainnet.json PROGRAM_ID=3cbH… BUFFER_KEYPAIR=~/mainnet-buffer-NEW.json ANCHOR_PROVIDER_URL=…`.

## 3. Test 2: запуск «дев = 0» — одной командой
Параметры (Роман, 2026-10-04): название `test2`, символ `TST`, оценка всего выпуска на старте **10 SOL** (первая монета стоит 10 / 1 000 000 000 SOL; выкупить долю f выпуска стоит ≈ 10·f/(1−f) SOL + 5% комиссии: за 0,5 SOL покупается ≈4,5% выпуска), выпуск 1 млрд монет, диапазон цены ×10 000, торги открываются через 10 минут после создания пула (`START_IN_SECS=600`), owner/admin/президент = новый кошелёк, параметры `prod`. Картинка: ссылка на JSON-метаданные (`URI`), см. ниже.
```bash
cd /Users/romantalanin/Desktop/onchain-state-solana-main && NAME=test2 SYMBOL=TST URI=<ссылка или пусто> START_FDV=10 START_IN_SECS=600 CONFIRM=yes caffeinate -i bash scripts/launch_test2.sh
```
`scripts/launch_test2.sh` — чистая «склейка» существующих скриптов (каждый много раз прогонялся на devnet): 1 `create_mint` (весь выпуск → кошелёк) → 2 `initialize` → 3 `setup_milestone_fund` → 4 `create_pool` (весь выпуск одной стороной, без SOL, позиция навсегда заблокирована и отдана государству) → 5 `register_pool` → 6 `revoke_mint_authority` (**необратимо**: больше нельзя печатать монеты; с непустым `URI` ещё и менять имя/картинку, `ALSO_METADATA=no` отключает) → 7 `launch_check` (должно быть «ALL PASS», 11 из 11). Без `CONFIRM=yes` только проверяет и печатает план. Если шаг упал (обычно обрыв сети) — та же команда с `FROM=<номер шага>` впереди; законченные шаги не повторяются (повторный `create_mint` и `create_pool` узнают свою прежнюю работу и продолжают, ключ монеты и файл пула пишутся ДО отправки транзакции).
Ключи/файлы: `~/test2-mint-mainnet.json` (ключ монеты), `~/test2-pool-mainnet.json` (адрес пула и позиции) — тоже в копию ключей. Торги открываются через 10 минут (часы сети отстают на несколько секунд — первую покупку делать минутой позже); перед стартом проверка ALL PASS уже будет напечатана. Покупка команды: `SIDE=buy AMOUNT=<SOL> npx ts-node scripts/pool_swap.ts` (команда с адресом монеты печатается в конце запуска), сбор комиссии в казну — `claim_pool_fees.ts`, отчёт — `pool_report.ts`.
Проверено на локальном валидаторе с клоном Meteora 2026-10-04 (не devnet, не mainnet): полный запуск за 14 с (ALL PASS), покупка/продажа/сбор комиссии после старта, повторный запуск законченных шагов безвреден, обрыв между созданием пула и передачей позиции → повторный `create_pool` докручивает передачу, `FROM=2` после ошибки, готовый файл ключа монеты. В ходе этого `create_mint.ts` (ключ сохраняется до отправки, подтверждение опросом по HTTP), `create_pool.ts` (файл пула до отправки, возобновление, время цепи через Clock) и `pool_swap.ts` (время цепи через Clock) стали устойчивее к обрывам публичного RPC.
Ручной вариант (то же по шагам, переменные: `GOVERNANCE_MINT=<адрес монеты>`, `OWNERS_AUTHORITY`, `ADMIN_AUTHORITY`, `PRESIDENT`, `PARAMS=prod`; `PARAMS=test` на mainnet запрещён): `create_mint.ts` → `initialize.ts` → `setup_milestone_fund.ts` → `create_pool.ts` (`SINGLE_SIDED=1 TOKEN_AMOUNT=all START_FDV=10 START_IN_SECS=600`) → `register_pool.ts` → `revoke_mint_authority.ts` (`CONFIRM=yes`) → `launch_check.ts`.
Стоимость выкупа доли f выпуска ≈ START_FDV·f/(1−f) (+5% комиссии: 1% уходит Meteora, 4% — в казну проекта).
