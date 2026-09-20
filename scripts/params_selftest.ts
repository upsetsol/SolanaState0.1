import { isMainnetRpc, resolveParams } from "./params";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

process.env.ANCHOR_PROVIDER_URL = "https://api.devnet.solana.com";
delete process.env.PARAMS;
let r = resolveParams();
if (r.profile !== "test") fail("devnet should default to test");
if (r.params.votingPeriodSecs !== 300) fail("test voting period");
if (r.params.payrollPresidentBps !== 10) fail("test payroll should not be 1%/day");
if (r.params.citizenshipThresholdBps !== 25) fail("citizenship threshold should be 0.25%");
if (r.params.milestoneDepositBps !== 1000) fail("test milestone deposit cap should be 10%");
if (r.params.spendCooldownSecs !== 120) fail("test spend cooldown");
if (r.params.execFallbackSecs !== 3_600) fail("test exec fallback");

process.env.PARAMS = "prod";
r = resolveParams();
if (r.profile !== "prod") fail("PARAMS=prod on devnet should be prod");
if (r.params.votingPeriodSecs !== 86_400) fail("prod voting period");
if (r.params.milestoneDepositBps !== 500) fail("prod milestone deposit cap should be 5%");
if (r.params.spendCooldownSecs !== 86_400) fail("prod spend cooldown should be 1 day");
if (r.params.execFallbackSecs !== 86_400) fail("prod exec fallback should be 1 day");

process.env.ANCHOR_PROVIDER_URL = "https://api.mainnet-beta.solana.com";
delete process.env.PARAMS;
r = resolveParams();
if (r.profile !== "prod") fail("mainnet must default to prod");

process.env.PARAMS = "test";
let threw = false;
try {
  resolveParams();
} catch {
  threw = true;
}
if (!threw) fail("mainnet + PARAMS=test must throw");

if (!isMainnetRpc("https://mainnet.helius-rpc.com")) fail("helius mainnet detect");
if (isMainnetRpc("https://api.devnet.solana.com")) fail("devnet is not mainnet");

console.log("params self-test ok");
