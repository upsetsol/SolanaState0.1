# On-Chain State — governance-программа (Solana / Anchor)

> ⚠️ **Эта ветка (`main`) — версия v3** (налог Token-2022 5% + `harvest_fees`), она стоит на testnet и обслуживает тестовый сайт.
> **Актуальная разработка — v4 в ветке [`pool-fees`](https://github.com/upsetsol/SolanaState0.1/tree/pool-fees)** (комиссия пула Meteora
> вместо налога; e2e 74/74 на реальном devnet). Контекст для нового человека или агента: [CLAUDE.md](CLAUDE.md).

Смарт-контракт «государства на блокчейне»: налог на транзакции (Token-2022
transfer-fee), казна, голосование холдеров по весам, роли
(президент / минфин / минкульт), зарплаты, вехи капитализации (Milestone Fund),
возможность передать права `owners_authority` другому адресу голосованием.

> **Статус:** функционально проверено (юнит-тесты + `scripts/e2e.ts` 53/53 на
> локальном валидаторе и на живом testnet), **не готово к мейннету**. Что остаётся закрыть —
> [OPEN_ITEMS.md](OPEN_ITEMS.md) (аудит, финальные параметры, mint, authority-ключи).

> **Хотите сами попробовать на testnet?** Пошаговая инструкция: [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md).
> Есть готовый **веб-интерфейс** для тестирования всех функций контракта: [web/README.md](web/README.md).

## Стек

- Solana + Anchor **1.1.2** (мейнлайн, под управлением Solana Foundation)
- Token-2022 (governance-токен с transfer-fee расширением)
- TypeScript-скрипты в `scripts/` — вызовы всех инструкций

## Быстрый старт (devnet, с нуля)

```bash
npm install
anchor build            # генерирует новый Program ID в target/deploy/*-keypair.json
anchor deploy            # первый деплой; про апгрейд см. ниже

# 1. создать governance-mint (Token-2022 + transfer-fee).
#    withheld-authority автоматически = Config PDA этой программы.
ANCHOR_WALLET=~/.config/solana/id.json \
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
FEE_BPS=500 INITIAL_SUPPLY=1000000000 \
npx ts-node scripts/create_mint.ts
export GOVERNANCE_MINT=<адрес из вывода>

# 2. инициализация
OWNERS_AUTHORITY=<ключ owner'а> ADMIN_AUTHORITY=<ключ admin'а> \
PARAMS=test \
npx ts-node scripts/initialize.ts

# 3. (опц.) фонд вех
npx ts-node scripts/setup_milestone_fund.ts
```

Все скрипты читают `GOVERNANCE_MINT` из окружения, а Program ID — из
`target/idl/onchain_state_solana.json` (`address`). Захардкоженных адресов
в скриптах больше нет (общий модуль `scripts/lib/env.ts`).

## Важные нюансы

**Ключ деплоя (`target/deploy/*-keypair.json`) не в репозитории — это
нормально.** При первом `anchor build` сгенерируется новый keypair и новый
Program ID. Скрипты подхватят его из IDL автоматически.

**`anchor deploy` (апгрейд уже существующей программы) в этой версии Anchor
сломан** — падает на `ExtendProgram`. Для апгрейда:
```bash
solana program deploy target/deploy/onchain_state_solana.so \
  --program-id target/deploy/onchain_state_solana-keypair.json
```
Первый деплой через `anchor deploy` работает.

**Вес голоса = реальный баланс токенов.** `owners_authority` постит снапшот
(`post_voter_snapshot`), но вес не передаётся числом — программа читает его
из настоящего токен-счёта холдера. Снапшоты можно добавлять только **до
первого голоса** по этому предложению (нельзя дописать своих, посмотрев на
ход голосования). Перед голосованием кто-то (owners) должен посчитать список
и занести снапшоты.

**Кворум считается от `supply − казна`** — от монет, реально гуляющих у
людей. Налог, осевший в казне, не поднимает планку явки.

**Timelock применяется ко ВСЕМ типам предложений, включая SPEND.** Деньги по
голосованию уходят не сразу после дедлайна, а после `deadline + timelock_secs`.

**Исполнять предложения может `owners_authority`** (не пермишнлесс). Запасной путь: если хозяева молчат `exec_fallback_secs` (prod — сутки) после окончания timelock, исполнить может **президент**. Он лишь запускает то, что уже одобрено голосованием, кворумом и timelock.

**Роли — разные адреса.** Президент, минфин и минкульт не могут совпадать.

**Зарплаты и лимиты министров — от «утреннего снимка» казны**, а не от
live-баланса. Первый вызов `claim_salary` / `minister_spend` в новых сутках
фиксирует снимок; `harvest_fees` в течение дня не раздувает сегодняшние лимиты.

**Лимиты министра — по РОЛИ, а не по кошельку.** Смена ключа минфина не
сбрасывает недельное окно (`SpendTracker` seeds = `["spend_tracker", config, role]`).

**Пополнение Milestone Fund — только через голосование** (тип предложения 6),
не больше `milestone_deposit_bps` казны за раз. Инструкции
`deposit_to_milestone_fund` (owner-бэкдор) больше нет.

**Нельзя проводить траты подряд.** Предложения, двигающие деньги из казны
(SPEND и пополнение фонда), исполняются не чаще одного раза в
`spend_cooldown_secs` (prod — раз в сутки). Смена ролей и параметров под
кулдаун не попадает.

**Вехи не могут пообещать одни и те же монеты дважды.** При `finalize_milestone`
пул вехи резервируется в `config.milestone_reserved`; база следующей вехи =
баланс фонда минус резерв. Награды команда рассылает сама:
`claim_milestone` не требует подписи «гражданина» — выплата пушится в его ATA.

**Остатки вех возвращаются в фонд.** Через `milestone_grace_secs` (prod — 30 дней)
после финализации owner вызывает `release_milestone_reserve`: невыплаченная часть
пула освобождается для следующих вех, веха закрывается (выплаты по ней больше
невозможны). Скрипт `scripts/release_milestone_reserve.ts`.

**Стартовая казна — 5% supply.** После `create_mint` и `initialize` запустите
`scripts/fund_treasury.ts` (`FUND_BPS=500`): перевод из кошелька-эмитента в казну (с учётом налога).

**`admin_authority`** (отдельный ключ, задаётся в `initialize`): может
- `set_pause(true/false)` — глобальная пауза всех трат из казны/фонда;
- `set_citizenship_threshold(bps)` — порог «кто гражданин» (по умолчанию 0.25%).
Всё остальное — только через голосование. Код и Config публичны, «скрытой»
эта возможность быть не может — это просто отдельная роль.

**`harvest_fees` нужно вызывать регулярно** (бот/крон). Пермишнлесс, но сам
не запускается. Не под паузой — это приток в казну, не трата.

**Границы CHANGE_PARAM.** Голосованием нельзя выставить абсурдные значения
(кворум 0 или >100%, зарплата >1%/день, timelock с переполнением i64 и т.п.) —
см. `check_param_bounds` и константы `MAX_*` / `MIN_*` в `lib.rs` (помечены
`// TUNE` — подстройте под запуск).

## Параметры

`scripts/params.ts`, профиль `PARAMS=test|prod`. На mainnet RPC `test`
запрещён. `citizenship_threshold_bps = 25` (0.25% supply).

## Тесты

```bash
npm run test:p0     # cargo unit-тесты (чистые функции) + params_selftest
```

Юнит-тесты (`#[cfg(test)] mod p0_tests` в `lib.rs`) покрывают: кворум-границу,
30%-cap, формулу вех `min(30% + 5%·(n−1), 50%)`, резерв вех, границы
параметров, утренний снимок казны, порядок финализации вех.

**`scripts/e2e.ts`** — самодостаточный прогон всех сценариев против живого
кластера (локальный валидатор или devnet): сам создаёт mint, инициализирует
с короткими окнами, раздаёт токены 3 холдерам и гоняет весь набор
(голосование, timelock, кулдаун трат, кворум, роли, лимиты министров,
зарплаты, пауза, депозит в фонд типа 6, вехи с резервом, harvest) +
негативные пути. Печатает таблицу PASS/FAIL.

```bash
solana-test-validator --reset &            # или devnet RPC
solana program deploy target/deploy/onchain_state_solana.so \
  --program-id target/deploy/onchain_state_solana-keypair.json
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node scripts/e2e.ts
```

Последний прогон: **53/53 PASS** на локальном валидаторе и на живом Solana testnet (программа `FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy`). Devnet-копия — старая версия (46/46).

Основные негативные сценарии покрыты `scripts/e2e.ts` и UI-тестом сайта (`web/tests`);
скрипты `scripts/test_*.ts` — точечные ручные проверки против живого кластера.
Полноценные интеграционные тесты (litesvm/bankrun) в CI — следующий шаг.

## Структура

```
programs/onchain-state-solana/src/lib.rs   — весь контракт, один файл
scripts/lib/env.ts                          — общий конфиг + хелперы
scripts/create_mint.ts                      — создание governance-mint
scripts/*.ts                                — по инструкции / сценарию
```

Типы предложений: 0 SPEND, 1 сменить президента, 2 назначить минфин,
3 назначить минкульт, 4 сменить параметр, 5 сменить owners_authority,
6 пополнить Milestone Fund.

Порядок запуска: `create_mint` → `initialize` → `fund_treasury` → `setup_milestone_fund`.
