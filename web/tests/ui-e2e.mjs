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
const snapAll = async (id) => {
  const c = card(id);
  await c.locator("summary").click();
  await c.getByRole("button", { name: "Внести всем держателям", exact: true }).click();
  await p.waitForTimeout(2500); await t.settle(); await p.waitForTimeout(1500); await t.settle();
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
  if (amount !== undefined) await p.locator('label.field:has(span:text-is("Сумма, токенов")) input, label.field:has(span:text-is("Новое значение (число)")) input').first().fill(String(amount));
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
  t.expectOk("инициализировать государство", await t.act("Инициализировать"));
  t.expectOk("стартовая казна 5%", await t.act("Перевести в казну"));
  t.expectOk("создать фонд вех", await t.act("Создать фонд вех"));
  const amounts = ["80000000", "20000000", "4000000"];
  for (let i = 0; i < 3; i++) {
    await p.locator('select:has(option:text("выбрать из списка"))').selectOption({ index: i + 2 });
    await t.fill("Токенов", amounts[i]);
    t.expectOk(`раздача токенов кошельку ${i + 2}`, await t.act("Отправить токены"));
  }
  const pks = await t.pubkeys();

  // ---------- two SPEND proposals ----------
  t.expectOk("создать предложение #0 (трата 1 000 000)", await createProposal({ amount: 1000000, reason: "spend one" }));
  t.expectOk("создать предложение #1 (трата 2 000 000)", await createProposal({ amount: 2000000, reason: "spend two" }));
  t.check("оба предложения видны в списке", (await p.locator(".prop").count()) === 2);
  await snapAll(0); await snapAll(1);
  t.check("снимки внесены (4 холдера × 2)", (await t.rows().filter({ hasText: "Снимок для" }).count()) >= 8, `строк журнала: ${await t.rows().filter({ hasText: "Снимок для" }).count()}`);
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

  // ---------- roles ----------
  t.expectOk("создать: назначить W3 министром финансов", await createProposal({ type: 2, target: pks[2], reason: "finance minister" }));
  await snapAll(2);
  await voteAs(0, 2, true); await voteAs(1, 2, true);
  t.check("#2 дошло до исполнения", await waitText(card(2), /Готово к исполнению/));
  await t.setActive(0);
  t.expectOk("owner исполняет назначение", await actIn(card(2), "Исполнить"));
  await t.tab("Обзор");
  t.check("Обзор показывает министра финансов", !(await t.text()).match(/Министр финансов\s*\n?\s*вакантно/));
  t.expectOk("создать: назначить W3 ещё и президентом (конфликт ролей)", await createProposal({ type: 1, target: pks[2], reason: "conflict" }));
  await snapAll(3);
  await voteAs(0, 3, true); await voteAs(1, 3, true);
  t.check("#3 дошло до исполнения", await waitText(card(3), /Готово к исполнению/));
  await t.setActive(0);
  t.expectErr("W3 не может быть и министром, и президентом → RoleConflict", await actIn(card(3), "Исполнить"), "RoleConflict");

  // ---------- salary and minister spend (as W3) ----------
  await t.setActive(2); await t.tab("Деньги");
  t.expectOk("зарплата министра финансов", await t.act("Забрать зарплату"));
  t.expectErr("вторая зарплата в тот же день → PayrollTooSoon", await t.act("Забрать зарплату"), "PayrollTooSoon");
  await t.fill("Сумма, токенов", "1000");
  t.expectOk("трата министра в пределах лимита", await t.act("Потратить"));
  await t.fill("Сумма, токенов", "5000000");
  t.expectErr("трата сверх дневного лимита → ExceedsDailyLimit", await t.act("Потратить"), "ExceedsDailyLimit");
  await t.setActive(1); await t.tab("Деньги");
  await t.fill("Сумма, токенов", "1000");
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
  t.expectOk("создать: пополнить фонд вех 1 000 000", await createProposal({ type: 6, amount: 1000000, reason: "fund milestone" }));
  await snapAll(4);
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

  // ---------- harvest ----------
  await t.tab("Деньги");
  await p.getByRole("button", { name: "Найти налог", exact: true }).click();
  await p.waitForTimeout(3000);
  const hv = await t.text();
  t.check("сайт нашёл невостребованный налог", /Найдено налога к сбору/.test(hv));
  t.expectOk("собрать налог в казну", await t.act("Собрать"));
  await p.screenshot({ path: "tests-final.png", fullPage: true });
} catch (e) { console.log("SCRIPT ERROR", e.message.split("\n")[0]); await p.screenshot({ path: "tests-error.png", fullPage: true }); }
summary();
await b.close();
