import { Connection } from "@solana/web3.js";

export type ParamProfile = "test" | "prod";

export type GovernanceParams = {
  votingPeriodSecs: number;
  proposalThresholdBps: number;
  quorumSpendBps: number;
  quorumRoleBps: number;
  quorumParamBps: number;
  financeDailyBps: number;
  financeWeeklyBps: number;
  cultureDailyBps: number;
  cultureWeeklyBps: number;
  timelockSecs: number;
  payrollPresidentBps: number;
  payrollFinanceBps: number;
  payrollCultureBps: number;
  citizenshipThresholdBps: number;
  milestoneDepositBps: number;
  spendCooldownSecs: number;
  execFallbackSecs: number;
  milestoneGraceSecs: number;
};

/** Short windows so a test cycle fits in one sitting. Not for mainnet. */
export const TEST_PARAMS: GovernanceParams = {
  votingPeriodSecs: 300,
  proposalThresholdBps: 100,
  quorumSpendBps: 500,
  quorumRoleBps: 1000,
  quorumParamBps: 1500,
  financeDailyBps: 50,
  financeWeeklyBps: 150,
  cultureDailyBps: 20,
  cultureWeeklyBps: 50,
  timelockSecs: 60,
  payrollPresidentBps: 10,
  payrollFinanceBps: 5,
  payrollCultureBps: 5,
  citizenshipThresholdBps: 25, // 0.25% of supply
  milestoneDepositBps: 1000, // ≤10% of treasury per governance-approved deposit
  spendCooldownSecs: 120, // min gap between executed SPEND / milestone-deposit proposals
  execFallbackSecs: 3_600, // president may execute if owners don't, after this long
  milestoneGraceSecs: 300, // after this, unclaimed milestone shares can return to the fund
};

/** Conservative production defaults. Tune before a real launch. */
export const PROD_PARAMS: GovernanceParams = {
  votingPeriodSecs: 86_400,
  proposalThresholdBps: 100,
  quorumSpendBps: 500,
  quorumRoleBps: 1000,
  quorumParamBps: 1500,
  financeDailyBps: 20,
  financeWeeklyBps: 50,
  cultureDailyBps: 10,
  cultureWeeklyBps: 30,
  timelockSecs: 86_400,
  payrollPresidentBps: 5,
  payrollFinanceBps: 3,
  payrollCultureBps: 3,
  citizenshipThresholdBps: 25, // 0.25% of supply
  milestoneDepositBps: 500, // ≤5% of treasury per governance-approved deposit
  spendCooldownSecs: 86_400, // one money-moving proposal per day
  execFallbackSecs: 86_400, // president executes if owners are silent for a day
  milestoneGraceSecs: 2_592_000, // 30 days to collect a milestone payout
};

export function isMainnetRpc(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes("mainnet");
}

/**
 * TEST params are allowed on localnet/devnet only.
 * Mainnet (or PARAMS=prod) always uses PROD. Mainnet + PARAMS=test throws.
 */
export function resolveParams(connection?: Connection): {
  profile: ParamProfile;
  params: GovernanceParams;
  rpcUrl: string;
} {
  const rpcUrl =
    process.env.ANCHOR_PROVIDER_URL ||
    connection?.rpcEndpoint ||
    "";
  const requested = (process.env.PARAMS || "").toLowerCase();
  const mainnet = isMainnetRpc(rpcUrl);

  if (mainnet && requested === "test") {
    throw new Error(
      "PARAMS=test is forbidden on a mainnet RPC. Use PARAMS=prod or a devnet URL."
    );
  }

  if (mainnet || requested === "prod") {
    return { profile: "prod", params: PROD_PARAMS, rpcUrl };
  }

  // Local rehearsals only (never reached on a mainnet RPC): PARAM_OVERRIDES='{"votingPeriodSecs":25,"timelockSecs":0,...}'
  // overrides single fields of the TEST profile (e.g. to mimic the live state with much shorter windows).
  let params = TEST_PARAMS;
  if (process.env.PARAM_OVERRIDES) {
    const o = JSON.parse(process.env.PARAM_OVERRIDES);
    for (const k of Object.keys(o)) if (!(k in TEST_PARAMS)) throw new Error(`PARAM_OVERRIDES: unknown field ${k}`);
    params = { ...TEST_PARAMS, ...o };
  }
  return { profile: "test", params, rpcUrl };
}
