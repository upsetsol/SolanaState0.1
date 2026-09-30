import { execSync } from "child_process";
import fs from "fs";
import { start, make, summary } from "./lib.mjs";
const { b, p } = await start();
const t = make(p);
const card = (id) => p.locator(".prop", { hasText: `#${id} ·` });
const actIn = async (loc, name) => {
  await loc.getByRole("button", { name, exact: true }).first().click();
  await p.waitForTimeout(700); await t.settle(); return t.top();
};
const waitText = async (loc, re, timeout = 150000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (re.test(await loc.innerText())) return true; await p.waitForTimeout(2500); }
  return false;
};
const rowCount = (re) => t.rows().filter({ hasText: re }).count();
const waitRows = async (re, n, timeout = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if ((await rowCount(re)) >= n) return true; await p.waitForTimeout(1000); }
  return false;
};
// v4.1: the owner enrols everybody from ONE scan («Внести всем держателям (один скан)»), then starts the voting («Начать голосование»)
const snapAll = async (id, holders = 4) => {
  const c = card(id);
  const before = await rowCount(/Снимок для/);
  await c.locator("summary").first().click();
  await c.getByRole("button", { name: "Внести всем держателям (один скан)", exact: true }).click();
  await waitRows(/Снимок для/, before + holders);
  await p.waitForTimeout(1200); await t.settle();
};
const openV = async (id) => {
  const c = card(id);
  if (!(await c.locator("details").first().evaluate((el) => el.open))) await c.locator("summary").first().click();
  return actIn(c, "Начать голосование");
};
const voteAs = async (walletIdx, id, support) => {
  await t.setActive(walletIdx);
  return actIn(card(id), support ? "Голосовать «за»" : "Голосовать «против»");
};
const createProposal = async ({ type = 0, amount, target, reason, param }) => {
  await t.tab("Предложения");
  await p.locator('label.field:has(span:text-is("Тип")) select').selectOption(String(type));
  if (target) await t.fill("Адрес", target);
  if (param !== undefined) await p.locator('label.field:has(span:text-is("Параметр")) select').selectOption(String(param));
  if (amount !== undefined) await p.locator('label.field:has(span:text-is("Сумма, SOL")) input, label.field:has(span:text-is("Новое значение (число)")) input').first().fill(String(amount));
  await t.fill("Причина / описание", reason);
  return t.act("Создать");
};
try {
  // ---------- setup ----------
  await t.tab("Настройка");
  for (let i = 0; i < 4; i++) { await p.getByRole("button", { name: "+ Тестовый кошелёк" }).click(); await t.sleep(250); }
  for (let i = 0; i < 4; i++) await t.act("Airdrop", { nth: i });
  await t.setActive(0);
  t.expectOk("создать токен", await t.act("Создать токен"));
  // the voting clock now starts at «Начать голосование»; give the UI actions of one round 60 s instead of the fast profile's 30 s
  await p.locator("summary", { hasText: "Параметры (" }).click();
  await t.fill("Голосование, сек", 60);
  t.expectOk("инициализировать государство", await t.act("Инициализировать"));
  t.expectOk("положить 0.5 SOL в казну (wSOL)", await t.act("Перевести в казну"));
  t.expectOk("создать фонд вех", await t.act("Создать фонд вех"));
  const amounts = ["80000000", "20000000", "4000000"];
  for (let i = 0; i < 3; i++) {
    await p.locator('select:has(option:text("выбрать из списка"))').selectOption({ index: i + 2 });
    await t.fill("Токенов", amounts[i]);
    t.expectOk(`раздача токенов кошельку ${i + 2}`, await t.act("Отправить токены"));
  }
  const pks = await t.pubkeys();

  // ---------- two SPEND proposals ----------
  t.expectOk("создать предложение #0 (трата 0.05 SOL)", await createProposal({ amount: 0.05, reason: "spend one" }));
  t.expectOk("создать предложение #1 (трата 0.02 SOL)", await createProposal({ amount: 0.02, reason: "spend two" }));
  t.check("оба предложения видны в списке", (await p.locator(".prop").count()) === 2);
  await snapAll(0); await snapAll(1);
  t.check("снимки внесены (4 холдера × 2)", (await t.rows().filter({ hasText: "Снимок для" }).count()) >= 8, `строк журнала: ${await t.rows().filter({ hasText: "Снимок для" }).count()}`);
  // v4.1: until the owner presses «Начать голосование» nobody can vote, and afterwards nobody can be enrolled any more
  t.check("до старта статус «Идёт запись избирателей»", /Идёт запись избирателей/.test(await card(0).innerText()));
  t.check("до старта кнопки «Голосовать» заблокированы", await card(0).getByRole("button", { name: "Голосовать «за»", exact: true }).isDisabled());
  t.expectOk("owner начинает голосование #0", await openV(0));
  t.expectOk("owner начинает голосование #1", await openV(1));
  t.check("после старта снимки больше не принимаются", await card(0).getByRole("button", { name: "Внести всем держателям (один скан)", exact: true }).isDisabled());
  // votes: #0 for(W1,W2) against(W3); #1 for(W1,W2)
  t.expectOk("W1 голос «за» #0", await voteAs(0, 0, true));
  t.expectOk("W1 голос «за» #1", await actIn(card(1), "Голосовать «за»"));
  t.expectErr("W1 повторный голос → AlreadyVoted", await actIn(card(0), "Голосовать «за»"), "AlreadyVoted");
  t.expectOk("W2 голос «за» #0", await voteAs(1, 0, true));
  t.expectOk("W2 голос «за» #1", await actIn(card(1), "Голосовать «за»"));
  t.expectOk("W3 голос «против» #0", await voteAs(2, 0, false));
  const c0 = await card(0).innerText();
  t.check("карточка #0 показывает голоса «за» и «против»", /За\s*\n?\s*[\d,]+/.test(c0) && c0.includes("Против"));

  // ---------- wait for timelock ----------
  await t.setActive(1);
  t.check("статус ждёт исполнения / идёт голосование", /Идёт голосование|Принято, ждёт|Готово к исполнению/.test(c0));
  const ready = await waitText(card(0), /Готово к исполнению/);
  t.check("предложение #0 дошло до «Готово к исполнению»", ready);
  t.expectErr("W2 (не owner) исполняет → NotOwner", await actIn(card(0), "Исполнить"), "NotOwner");
  await t.setActive(0);
  t.expectOk("owner исполняет #0", await actIn(card(0), "Исполнить"));
  t.check("#0 помечено «Исполнено»", /Исполнено/.test(await card(0).innerText()));
  t.expectErr("#1 сразу после #0 → SpendCooldown", await actIn(card(1), "Исполнить"), "SpendCooldown");
  await p.waitForTimeout(16000);
  t.expectOk("#1 после паузы исполняется", await actIn(card(1), "Исполнить"));
  t.expectErr("повторное исполнение #0 → AlreadyExecuted", await actIn(card(0), "Исполнить"), "AlreadyExecuted");

  // ---------- clean-up of a finished proposal (v4.1): the rent goes back ----------
  const closedBefore = await rowCount(/Закрыть снимок/);
  await card(0).getByRole("button", { name: "Закрыть снимки этого предложения (вернуть аренду)", exact: true }).click();
  t.check("закрыты все 4 снимка предложения #0", await waitRows(/Закрыть снимок/, closedBefore + 4));
  await p.waitForTimeout(1000); await t.settle();
  const badClose = await t.rows().filter({ hasText: /Закрыть снимок/ }).evaluateAll((els) => els.filter((e) => e.className.includes("err")).length);
  t.check("закрытие снимков прошло без ошибок", badClose === 0, `с ошибкой: ${badClose}`);
  t.expectOk("закрыть исполненное предложение #0 (аренда → создателю)", await actIn(card(0), "Закрыть предложение"));
  t.check("закрытое предложение #0 исчезло из списка", await (async () => { for (let i = 0; i < 12; i++) { if ((await card(0).count()) === 0) return true; await p.waitForTimeout(2500); } return false; })());

  // ---------- roles ----------
  t.expectOk("создать: назначить W3 министром финансов", await createProposal({ type: 2, target: pks[2], reason: "finance minister" }));
  await snapAll(2); await openV(2);
  await voteAs(0, 2, true); await voteAs(1, 2, true);
  t.check("#2 дошло до исполнения", await waitText(card(2), /Готово к исполнению/));
  await t.setActive(0);
  t.expectOk("owner исполняет назначение", await actIn(card(2), "Исполнить"));
  await t.tab("Обзор");
  t.check("Обзор показывает министра финансов", !(await t.text()).match(/Министр финансов\s*\n?\s*вакантно/));
  t.expectOk("создать: назначить W3 ещё и президентом (конфликт ролей)", await createProposal({ type: 1, target: pks[2], reason: "conflict" }));
  await snapAll(3); await openV(3);
  await voteAs(0, 3, true); await voteAs(1, 3, true);
  t.check("#3 дошло до исполнения", await waitText(card(3), /Готово к исполнению/));
  await t.setActive(0);
  t.expectErr("W3 не может быть и министром, и президентом → RoleConflict", await actIn(card(3), "Исполнить"), "RoleConflict");

  // ---------- salary and minister spend (as W3) ----------
  await t.setActive(2); await t.tab("Деньги");
  t.expectOk("зарплата министра финансов", await t.act("Забрать зарплату"));
  t.expectErr("вторая зарплата в тот же день → PayrollTooSoon", await t.act("Забрать зарплату"), "PayrollTooSoon");
  await t.fill("Сумма, SOL", "0.001");
  t.expectOk("трата министра в пределах лимита", await t.act("Потратить"));
  await t.fill("Сумма, SOL", "0.05");
  t.expectErr("трата сверх дневного лимита → ExceedsDailyLimit", await t.act("Потратить"), "ExceedsDailyLimit");
  await t.setActive(1); await t.tab("Деньги");
  await t.fill("Сумма, SOL", "0.001");
  t.expectErr("W2 без роли пробует потратить → NotMinister", await t.act("Потратить"), "NotMinister");

  // ---------- pause ----------
  await t.setActive(0); await t.tab("Админ");
  t.expectOk("admin включает паузу", await t.act("Включить паузу"));
  await t.setActive(2); await t.tab("Деньги");
  t.expectErr("зарплата при паузе → Paused", await t.act("Забрать зарплату"), "Paused");
  await t.setActive(1); await t.tab("Админ");
  t.expectErr("не-admin снимает паузу → NotAdmin", await t.act("Снять паузу"), "NotAdmin");
  await t.setActive(0);
  t.expectOk("admin снимает паузу", await t.act("Снять паузу"));

  // ---------- milestone ----------
  await p.waitForTimeout(3000);
  t.expectOk("создать: пополнить фонд вех 0.03 SOL", await createProposal({ type: 6, amount: 0.03, reason: "fund milestone" }));
  await snapAll(4); await openV(4);
  await voteAs(0, 4, true); await voteAs(1, 4, true);
  t.check("#4 дошло до исполнения", await waitText(card(4), /Готово к исполнению/));
  await t.setActive(0);
  t.expectOk("owner исполняет пополнение фонда", await actIn(card(4), "Исполнить"));
  await t.tab("Вехи");
  t.expectOk("создать веху №1", await t.act("Создать веху №1"));
  await p.getByRole("button", { name: "Внести всех подходящих", exact: true }).click();
  await p.waitForTimeout(2500); await t.settle(); await p.waitForTimeout(1500); await t.settle();
  t.check("снимки граждан внесены", (await t.rows().filter({ hasText: "Снимок гражданина" }).count()) >= 3, `${await t.rows().filter({ hasText: "Снимок гражданина" }).count()} шт`);
  t.expectOk("закрыть веху №1", await t.act("Закрыть веху"));
  t.expectOk("выплата первому гражданину", await t.act("Выплатить", { nth: 0 }));
  t.expectErr("повторная выплата → AlreadyClaimedMilestone", await t.act("Выплатить", { nth: 0 }), "AlreadyClaimedMilestone");
  t.expectErr("вернуть остаток до срока → MilestoneGraceNotElapsed", await t.act("Вернуть невыплаченный остаток в фонд"), "MilestoneGraceNotElapsed");
  await p.waitForTimeout(22000);
  t.expectOk("вернуть остаток в фонд после срока", await t.act("Вернуть невыплаченный остаток в фонд"));
  t.expectErr("выплата по закрытой вехе → MilestoneClosed", await t.act("Выплатить", { nth: 1 }), "MilestoneClosed");

  // ---------- pool fee cycle (the pool itself is created by the console script) ----------
  await t.tab("Настройка");
  const burners = await p.evaluate(() => JSON.parse(localStorage.getItem("burners") || "[]"));
  const st = await p.evaluate(() => JSON.parse(localStorage.getItem("settings") || "{}"));
  fs.writeFileSync("../.ui-w0.json", JSON.stringify(burners[0].secret));
  fs.writeFileSync("../.ui-w1.json", JSON.stringify(burners[1].secret));
  const base = { ...process.env, ANCHOR_PROVIDER_URL: "http://127.0.0.1:8899", GOVERNANCE_MINT: st.mint };
  const sh = (cmd, env) => execSync(cmd, { cwd: "..", env: { ...base, ...env }, stdio: "pipe" }).toString();
  try {
    sh("npx ts-node scripts/create_pool.ts", { ANCHOR_WALLET: ".ui-w0.json", POOL_OUT: ".ui-pool.json", TOKEN_AMOUNT: "10000000", QUOTE_AMOUNT: "0.1" });
    const pool = JSON.parse(fs.readFileSync("../.ui-pool.json", "utf8"));
    await t.fill("Адрес пула", pool.pool);
    await t.fill("Mint NFT позиции", pool.positionNft);
    await t.setActive(1);
    t.expectErr("привязать пул не от owner → NotOwner", await t.act("Привязать пул"), "NotOwner");
    await t.setActive(0);
    t.expectOk("привязать пул (owner)", await t.act("Привязать пул"));
    await t.tab("Обзор");
    t.check("Обзор показывает привязанный пул", /Позиция \(владеет Config PDA\)/.test(await t.text()));
    await t.tab("Предложения");
    t.expectOk("создать предложение после привязки пула (хранилище пула передаётся)", await createProposal({ amount: 0.001, reason: "after pool" }));
    sh("npx ts-node scripts/pool_swap.ts", { KEYPAIR: ".ui-w1.json", SIDE: "buy", AMOUNT: "0.05" });
    await t.setActive(2); await t.tab("Деньги");
    await p.waitForTimeout(9000); // the panel refreshes every 8 s
    t.check("сайт показывает комиссию, ждущую сбора", /Комиссия ждёт сбора\s*\n?\s*0\.0\d+/.test(await t.text()), (await t.text()).match(/Комиссия ждёт сбора[^\n]*\n?[^\n]*/)?.[0] ?? "");
    t.expectOk("любой (W3) забирает комиссию в казну", await t.act("Забрать комиссию"));
    await p.waitForTimeout(9000);
    t.check("после сбора ждущей комиссии почти нет", /Комиссия ждёт сбора\s*\n?\s*0(\s|\n|$)/.test(await t.text()));
  } finally {
    for (const f of [".ui-w0.json", ".ui-w1.json", ".ui-pool.json"]) { try { fs.unlinkSync("../" + f); } catch { /* */ } }
  }
  await p.screenshot({ path: "tests-final.png", fullPage: true });
} catch (e) { console.log("SCRIPT ERROR", e.message.split("\n")[0]); await p.screenshot({ path: "tests-error.png", fullPage: true }); }
summary();
await b.close();
