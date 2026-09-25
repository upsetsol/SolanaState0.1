use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy");

// ============================================================================
// v4 — pool-fee model. Two different mints now:
//  * governance_mint: the state's own coin. It only gives voting weight
//    (snapshots, quorum, "citizen" threshold). NO transfer tax.
//  * treasury_mint: the pool's quote asset (wSOL / USDC / USDT). Treasury,
//    salaries, minister limits, SPEND proposals, milestone fund and payouts
//    are all denominated in it.
//  The treasury is fed by the trading fee of a Meteora DAMM v2 pool
//  (governance_mint / treasury_mint, collect-fee mode "only B"). The
//  liquidity position (an NFT) belongs to the Config PDA; anyone can call
//  claim_pool_fees, and the fee can only land on the treasury account.
//
// Rules carried over from v3 (see README):
//  * Vote weight = the voter's REAL token balance, checked when the snapshot
//    is posted; snapshots only BEFORE the first vote.
//  * Quorum / proposal-creation threshold: measured against the circulating
//    supply (supply minus the balance of the registered pool vault).
//  * Timelock on every proposal type; execute is owners_authority-only with a
//    president fallback after exec_fallback_secs.
//  * President / finance minister / culture minister are distinct addresses.
//  * CHANGE_PARAM values are bounds-checked (check_param_bounds).
//  * admin_authority: pause + citizenship threshold.
//  * Salaries and minister limits use a once-a-day "morning" snapshot of the
//    treasury, so fees claimed in the afternoon can't raise today's caps.
//  * Minister limits are per ROLE; Milestone Fund only via governance
//    (proposal type 6, capped); milestone pools are reserved at finalize and
//    unclaimed parts return after milestone_grace_secs; money-moving
//    proposals obey spend_cooldown_secs.
// ============================================================================

pub const BPS_DENOM: u64 = 10_000;
/// Hard ceiling — no SPEND proposal can request more than
/// 30% of the current treasury, even if 100% of holders vote "for".
pub const MAX_SPEND_BPS: u64 = 3_000;
pub const SECONDS_PER_DAY: i64 = 86_400;
pub const SECONDS_PER_WEEK: i64 = 604_800;

// --- CHANGE_PARAM safety rails. TUNE before a real launch. -------------------
// These only gate governance-driven parameter changes (proposal type 4);
// the very first `initialize` is the deployer's responsibility.
pub const MIN_VOTING_PERIOD_SECS: i64 = 300;
pub const MAX_VOTING_PERIOD_SECS: i64 = 30 * SECONDS_PER_DAY;
pub const MAX_TIMELOCK_SECS: i64 = 14 * SECONDS_PER_DAY;
pub const MAX_SPEND_COOLDOWN_SECS: i64 = 30 * SECONDS_PER_DAY;
pub const MIN_EXEC_FALLBACK_SECS: i64 = 3_600;
pub const MAX_EXEC_FALLBACK_SECS: i64 = 30 * SECONDS_PER_DAY;
/// Max % of the morning treasury a role's salary can be set to, per day.
pub const MAX_PAYROLL_BPS: u64 = 100; // 1%/day
/// Max % of the morning treasury a minister daily/weekly limit can be set to.
pub const MAX_MINISTER_BPS: u64 = 2_000; // 20%
pub const MIN_QUORUM_BPS: u64 = 1;

// --- Meteora DAMM v2 (cp-amm) ------------------------------------------------
/// Program that owns the pool + position we register and claim fees from.
pub const METEORA_CP_AMM: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// Anchor discriminator of cp-amm `claim_position_fee` (no arguments).
pub const CLAIM_POSITION_FEE_DISC: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
/// Byte offsets inside cp-amm accounts (8-byte Anchor discriminator included).
/// Checked against live pools; see experiments/dex and scripts/pool_fees_e2e.ts.
pub const POOL_TOKEN_A_MINT_OFFSET: usize = 168;
pub const POOL_TOKEN_B_MINT_OFFSET: usize = 200;
pub const POOL_TOKEN_A_VAULT_OFFSET: usize = 232;
pub const POOL_TOKEN_B_VAULT_OFFSET: usize = 264;
pub const POOL_COLLECT_FEE_MODE_OFFSET: usize = 484;
pub const POSITION_POOL_OFFSET: usize = 8;
pub const POSITION_NFT_MINT_OFFSET: usize = 40;
/// collect_fee_mode value meaning "trading fee is taken only in token B".
pub const COLLECT_FEE_ONLY_B: u8 = 1;

// ==================== Pure helpers (unit-tested below) ====================

/// The base used for quorum / proposal-creation math: governance coins that
/// can actually vote — total supply minus what sits in the registered pool
/// vault (coins in a pool have no voter). `excluded` is 0 when no pool is registered.
pub fn voting_base(supply: u128, excluded: u64) -> u128 {
    supply.saturating_sub(excluded as u128)
}

/// True when the votes cast clear the quorum bar against the voting base.
pub fn quorum_met(total_votes: u128, supply: u128, excluded: u64, quorum_bps: u64) -> bool {
    total_votes.saturating_mul(BPS_DENOM as u128)
        >= voting_base(supply, excluded).saturating_mul(quorum_bps as u128)
}

/// Reads a 32-byte key out of a foreign account's raw data (None if too short).
pub fn read_key_at(data: &[u8], offset: usize) -> Option<Pubkey> {
    let end = offset.checked_add(32)?;
    let bytes: [u8; 32] = data.get(offset..end)?.try_into().ok()?;
    Some(Pubkey::new_from_array(bytes))
}

/// Governance-coin balance excluded from the voting base. Zero until a pool is
/// registered; afterwards the pool's token-A vault must be passed in.
fn excluded_amount(
    config: &Config,
    account: Option<&InterfaceAccount<TokenAccount>>,
) -> Result<u64> {
    if config.quorum_excluded_account == Pubkey::default() {
        return Ok(0);
    }
    let acc = account.ok_or(error!(GovError::ExcludedAccountMissing))?;
    require_keys_eq!(acc.key(), config.quorum_excluded_account, GovError::ExcludedAccountMissing);
    Ok(acc.amount)
}

/// 30%-of-treasury ceiling for a single SPEND proposal.
pub fn spend_cap(treasury_amount: u64) -> u128 {
    (treasury_amount as u128) * MAX_SPEND_BPS as u128 / BPS_DENOM as u128
}

/// Who may execute a passed proposal: owners_authority any time after the
/// timelock; the president only as a fallback, once `fallback_secs` have
/// passed after the timelock without owners acting. The president can only
/// trigger what the community already approved (vote + quorum + timelock).
pub fn can_execute(
    executor: &Pubkey,
    owners: &Pubkey,
    president: &Pubkey,
    now: i64,
    unlock_at: i64,
    fallback_secs: i64,
) -> bool {
    executor == owners
        || (executor == president && now >= unlock_at.saturating_add(fallback_secs))
}

/// True when enough time has passed since the last money-moving proposal was
/// executed (SPEND / milestone deposit). Stops back-to-back drains.
pub fn spend_cooldown_ok(last_spend_ts: i64, now: i64, cooldown_secs: i64) -> bool {
    last_spend_ts == 0 || now.saturating_sub(last_spend_ts) >= cooldown_secs
}

/// Payout share for milestone n: min(30% + 5%*(n-1), 50%).
pub fn payout_bps_for(n: u64) -> u64 {
    core::cmp::min(3_000 + 500 * n.saturating_sub(1), 5_000)
}

/// The pool a milestone pays out: base * payout_bps / 10000.
pub fn milestone_pool(base: u64, payout_bps: u64) -> u128 {
    (base as u128) * (payout_bps as u128) / BPS_DENOM as u128
}

/// Part of a milestone pool nobody claimed — goes back to the fund on release.
pub fn milestone_unclaimed(pool: u128, claimed: u64) -> u64 {
    pool.saturating_sub(claimed as u128) as u64
}

/// One citizen's share of a milestone pool, by weight.
pub fn milestone_share(pool: u128, weight: u128, total_weight: u128) -> u64 {
    if total_weight == 0 {
        return 0;
    }
    (pool * weight / total_weight) as u64
}

/// Day index (floor division so negative timestamps behave).
pub fn day_index(now: i64) -> i64 {
    now.div_euclid(SECONDS_PER_DAY)
}

/// Bounds check for a governance-driven parameter change.
/// param_key mapping is the same as the match in execute_proposal.
pub fn check_param_bounds(param_key: u8, amount: u64) -> Result<()> {
    // Keys 0, 9, 13 get cast to i64 — reject anything that wouldn't fit.
    if param_key == 0 || param_key == 9 || param_key == 13 || param_key == 14 {
        require!(amount <= i64::MAX as u64, GovError::ParamOutOfBounds);
    }
    match param_key {
        0 => {
            let v = amount as i64;
            require!(
                v >= MIN_VOTING_PERIOD_SECS && v <= MAX_VOTING_PERIOD_SECS,
                GovError::ParamOutOfBounds
            );
        }
        9 => {
            let v = amount as i64;
            require!(v >= 0 && v <= MAX_TIMELOCK_SECS, GovError::ParamOutOfBounds);
        }
        14 => {
            let v = amount as i64;
            require!(
                v >= MIN_EXEC_FALLBACK_SECS && v <= MAX_EXEC_FALLBACK_SECS,
                GovError::ParamOutOfBounds
            );
        }
        13 => {
            let v = amount as i64;
            require!(v >= 0 && v <= MAX_SPEND_COOLDOWN_SECS, GovError::ParamOutOfBounds);
        }
        // proposal threshold + the three quorums: must be a real 1..=100% figure
        1 | 2 | 3 | 4 => {
            require!(
                amount >= MIN_QUORUM_BPS && amount <= BPS_DENOM,
                GovError::ParamOutOfBounds
            );
        }
        // minister daily/weekly limits
        5 | 6 | 7 | 8 => {
            require!(amount <= MAX_MINISTER_BPS, GovError::ParamOutOfBounds);
        }
        // payroll bps
        10 | 11 | 12 => {
            require!(amount <= MAX_PAYROLL_BPS, GovError::ParamOutOfBounds);
        }
        _ => return err!(GovError::InvalidParamKey),
    }
    Ok(())
}

/// Refresh the once-a-day treasury snapshot if we've rolled into a new day.
fn refresh_treasury_snapshot(config: &mut Config, treasury_amount: u64, now: i64) {
    let day = day_index(now);
    if config.treasury_snapshot_day != day {
        config.treasury_snapshot_day = day;
        config.treasury_snapshot_amount = treasury_amount;
    }
}

#[program]
pub mod onchain_state_solana {
    use super::*;

    /// Sets up Config + treasury (an ATA of treasury_mint, owned by the Config PDA).
    /// governance_mint = the voting coin, treasury_mint = the asset the pool pays
    /// its fee in (wSOL / USDC / USDT). `token_program` is the treasury asset's program.
    /// `owners_authority` (the owner's key) posts vote snapshots and
    /// executes proposals. `admin_authority` (a separate key/multisig) can pause
    /// treasury outflows and tune the citizenship threshold. The payer signs and
    /// pays rent but gets no standing power. Ministers start vacant.
    pub fn initialize(
        ctx: Context<Initialize>,
        owners_authority: Pubkey,
        admin_authority: Pubkey,
        president: Pubkey,
        voting_period_secs: i64,
        proposal_threshold_bps: u64,
        quorum_spend_bps: u64,
        quorum_role_bps: u64,
        quorum_param_bps: u64,
        finance_daily_bps: u64,
        finance_weekly_bps: u64,
        culture_daily_bps: u64,
        culture_weekly_bps: u64,
        timelock_secs: i64,
        payroll_president_bps: u64,
        payroll_finance_bps: u64,
        payroll_culture_bps: u64,
        citizenship_threshold_bps: u64,
        milestone_deposit_bps: u64,
        spend_cooldown_secs: i64,
        exec_fallback_secs: i64,
        milestone_grace_secs: i64,
    ) -> Result<()> {
        require!(owners_authority != Pubkey::default(), GovError::ZeroAddress);
        require!(admin_authority != Pubkey::default(), GovError::ZeroAddress);
        require!(president != Pubkey::default(), GovError::ZeroAddress);
        require!(voting_period_secs > 0, GovError::InvalidBps);
        require!(timelock_secs >= 0, GovError::InvalidBps);
        require!(spend_cooldown_secs >= 0, GovError::InvalidBps);
        require!(exec_fallback_secs > 0, GovError::InvalidBps);
        require!(milestone_grace_secs >= 0, GovError::InvalidBps);
        require!(citizenship_threshold_bps <= BPS_DENOM, GovError::InvalidBps);
        require!(milestone_deposit_bps <= BPS_DENOM, GovError::InvalidBps);
        require_keys_neq!(
            ctx.accounts.governance_mint.key(),
            ctx.accounts.treasury_mint.key(),
            GovError::InvalidBps
        );

        let config = &mut ctx.accounts.config;
        config.owners_authority = owners_authority;
        config.admin_authority = admin_authority;
        config.president = president;
        config.finance_minister = Pubkey::default(); // vacant until APPOINT_ROLE
        config.culture_minister = Pubkey::default();
        config.governance_mint = ctx.accounts.governance_mint.key();
        config.treasury_mint = ctx.accounts.treasury_mint.key();
        config.treasury_token_account = ctx.accounts.treasury.key();
        config.fee_pool = Pubkey::default();
        config.fee_position = Pubkey::default();
        config.fee_position_nft_account = Pubkey::default();
        config.quorum_excluded_account = Pubkey::default();
        config.milestone_fund_token_account = Pubkey::default();
        config.voting_period_secs = voting_period_secs;
        config.proposal_threshold_bps = proposal_threshold_bps;
        config.quorum_spend_bps = quorum_spend_bps;
        config.quorum_role_bps = quorum_role_bps;
        config.quorum_param_bps = quorum_param_bps;
        config.finance_daily_bps = finance_daily_bps;
        config.finance_weekly_bps = finance_weekly_bps;
        config.culture_daily_bps = culture_daily_bps;
        config.culture_weekly_bps = culture_weekly_bps;
        config.timelock_secs = timelock_secs;
        config.payroll_president_bps = payroll_president_bps;
        config.payroll_finance_bps = payroll_finance_bps;
        config.payroll_culture_bps = payroll_culture_bps;
        config.citizenship_threshold_bps = citizenship_threshold_bps;
        config.milestone_deposit_bps = milestone_deposit_bps;
        config.spend_cooldown_secs = spend_cooldown_secs;
        config.last_spend_ts = 0;
        config.exec_fallback_secs = exec_fallback_secs;
        config.milestone_grace_secs = milestone_grace_secs;
        config.milestone_reserved = 0;
        config.treasury_snapshot_amount = 0;
        // Sentinel: 0 is never a real day index, so the first claim_salary /
        // minister_spend refreshes the snapshot to the real treasury balance
        // instead of being stuck at 0 for the rest of the first day.
        config.treasury_snapshot_day = 0;
        config.next_milestone_number = 1;
        config.proposal_count = 0;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// admin_authority flips the global pause on all treasury/fund outflows.
    /// Meant as a break-glass while a bug is being patched.
    pub fn set_pause(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin_authority,
            GovError::NotAdmin
        );
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// admin_authority tunes the "who counts as a citizen" threshold.
    /// Kept off the voting path deliberately (see project notes).
    pub fn set_citizenship_threshold(ctx: Context<AdminOnly>, bps: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin_authority,
            GovError::NotAdmin
        );
        require!(bps <= BPS_DENOM, GovError::ParamOutOfBounds);
        ctx.accounts.config.citizenship_threshold_bps = bps;
        Ok(())
    }

    /// Claim salary for a role — once a day, a fixed % of the MORNING treasury
    /// snapshot (not the live balance). Does not use up minister_spend's
    /// daily/weekly limit — this is separate, guaranteed income for holding
    /// the role.
    pub fn claim_salary(ctx: Context<ClaimSalary>) -> Result<()> {
        require!(!ctx.accounts.config.paused, GovError::Paused);
        let signer = ctx.accounts.claimant.key();
        let cfg = &ctx.accounts.config;

        let (role, bps) = if signer == cfg.president {
            (0u8, cfg.payroll_president_bps)
        } else if signer == cfg.finance_minister {
            (1u8, cfg.payroll_finance_bps)
        } else if signer == cfg.culture_minister {
            (2u8, cfg.payroll_culture_bps)
        } else {
            return err!(GovError::NotEligibleForPayroll);
        };

        let now = Clock::get()?.unix_timestamp;
        let claim = &mut ctx.accounts.payroll_claim;
        if claim.last_claim_ts != 0 {
            require!(now - claim.last_claim_ts >= SECONDS_PER_DAY, GovError::PayrollTooSoon);
        }

        let treasury_amount = ctx.accounts.treasury.amount;
        refresh_treasury_snapshot(&mut ctx.accounts.config, treasury_amount, now);

        let base = ctx.accounts.config.treasury_snapshot_amount as u128;
        let payout = (base * bps as u128 / BPS_DENOM as u128) as u64;
        require!(payout > 0, GovError::NothingToClaim);

        claim.role = role;
        claim.last_claim_ts = now;
        claim.bump = ctx.bumps.payroll_claim;

        let mint_key = ctx.accounts.config.governance_mint;
        let seeds: &[&[u8]] = &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.treasury.to_account_info(),
                    mint: ctx.accounts.treasury_mint.to_account_info(),
                    to: ctx.accounts.claimant_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
            ctx.accounts.treasury_mint.decimals,
        )?;
        Ok(())
    }

    /// Manual snapshot: only owners_authority can register a voter's weight
    /// for a proposal. The weight is NOT a free-form number — it must equal
    /// the voter's real balance in `voter_token_account` right now. Snapshots
    /// can only be added while no vote has been cast yet, so owners can't
    /// watch the tally and add favourable voters later. Created once (`init`):
    /// weight cannot be rewritten and `consumed` cannot be cleared.
    pub fn post_voter_snapshot(
        ctx: Context<PostVoterSnapshot>,
        _proposal_id: u64,
        voter: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owners_authority,
            GovError::NotOwner
        );
        require!(
            ctx.accounts.proposal.votes_for == 0 && ctx.accounts.proposal.votes_against == 0,
            GovError::VotingAlreadyStarted
        );

        let snap = &mut ctx.accounts.voter_snapshot;
        snap.proposal = ctx.accounts.proposal.key();
        snap.voter = voter;
        snap.weight = ctx.accounts.voter_token_account.amount;
        snap.consumed = false;
        snap.bump = ctx.bumps.voter_snapshot;
        Ok(())
    }

    /// Create a proposal. Unlike voting, the creation threshold reads the
    /// creator's LIVE balance against the voting base (supply - pool vault)
    /// — deliberately fine, because creating a proposal doesn't execute
    /// anything, it just opens a discussion.
    /// proposal_type: 0=SPEND 1=ChangePresident 2=AppointFinance
    ///                3=AppointCulture 4=ChangeParam 5=ChangeOwnersAuthority
    ///                6=DepositToMilestoneFund
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        proposal_type: u8,
        target: Pubkey,
        amount: u64,
        param_key: u8,
        reason: String,
    ) -> Result<()> {
        require!(reason.len() <= 200, GovError::ReasonTooLong);
        require!(proposal_type <= 6, GovError::InvalidProposalType);

        let supply = ctx.accounts.governance_mint.supply as u128;
        let treasury_balance = ctx.accounts.treasury.amount;
        let excluded =
            excluded_amount(&ctx.accounts.config, ctx.accounts.quorum_excluded.as_deref())?;
        let base = voting_base(supply, excluded);
        let creator_balance = ctx.accounts.creator_token_account.amount as u128;
        let threshold_bps = ctx.accounts.config.proposal_threshold_bps as u128;
        require!(
            creator_balance * BPS_DENOM as u128 >= base * threshold_bps,
            GovError::BelowThreshold
        );

        if proposal_type == 0 {
            // SPEND
            require!((amount as u128) <= spend_cap(treasury_balance), GovError::ExceedsSpendCap);
            require!((amount as u128) <= treasury_balance as u128, GovError::InsufficientTreasury);
        } else if proposal_type == 6 {
            // DEPOSIT_TO_MILESTONE_FUND — capped at milestone_deposit_bps of treasury
            let cap = (treasury_balance as u128)
                * ctx.accounts.config.milestone_deposit_bps as u128
                / BPS_DENOM as u128;
            require!((amount as u128) <= cap, GovError::ExceedsMilestoneDepositCap);
            require!((amount as u128) <= treasury_balance as u128, GovError::InsufficientTreasury);
        }

        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let proposal = &mut ctx.accounts.proposal;
        proposal.id = config.proposal_count;
        proposal.proposal_type = proposal_type;
        proposal.creator = ctx.accounts.creator.key();
        proposal.target = target;
        proposal.amount = amount;
        proposal.param_key = param_key;
        proposal.reason = reason;
        proposal.votes_for = 0;
        proposal.votes_against = 0;
        proposal.created_at = now;
        proposal.deadline = now + config.voting_period_secs;
        proposal.executed = false;
        proposal.bump = ctx.bumps.proposal;

        config.proposal_count = config.proposal_count.checked_add(1).unwrap();
        Ok(())
    }

    /// Holders vote themselves, each with their own transaction — weight comes
    /// from the verified snapshot (VoterSnapshot), which must already exist.
    pub fn vote(ctx: Context<Vote>, _proposal_id: u64, support: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= ctx.accounts.proposal.deadline, GovError::ProposalNotActive);

        let snap = &mut ctx.accounts.voter_snapshot;
        require_keys_eq!(snap.voter, ctx.accounts.voter.key(), GovError::NotYourSnapshot);
        require!(!snap.consumed, GovError::AlreadyVoted);
        require!(snap.weight > 0, GovError::NoWeight);

        let proposal = &mut ctx.accounts.proposal;
        if support {
            proposal.votes_for = proposal.votes_for.checked_add(snap.weight).unwrap();
        } else {
            proposal.votes_against = proposal.votes_against.checked_add(snap.weight).unwrap();
        }
        snap.consumed = true;
        Ok(())
    }

    /// Executes a proposal. owners_authority only. The deadline must have
    /// passed, quorum + majority met, and the timelock elapsed (for EVERY
    /// type, SPEND included). For SPEND — re-checks the 30% cap at execution
    /// time.
    pub fn execute_proposal(ctx: Context<ExecuteProposal>, _proposal_id: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, GovError::Paused);

        let now = Clock::get()?.unix_timestamp;
        require!(now > ctx.accounts.proposal.deadline, GovError::ProposalStillActive);
        require!(!ctx.accounts.proposal.executed, GovError::AlreadyExecuted);

        let proposal_type = ctx.accounts.proposal.proposal_type;

        // Types 4 (param) and 6 (milestone deposit) don't use `target`.
        if proposal_type != 4 && proposal_type != 6 {
            require!(
                ctx.accounts.proposal.target != Pubkey::default(),
                GovError::ZeroAddress
            );
        }

        let supply = ctx.accounts.governance_mint.supply as u128;
        let quorum_bps = match proposal_type {
            0 | 6 => ctx.accounts.config.quorum_spend_bps,
            1 | 2 | 3 => ctx.accounts.config.quorum_role_bps,
            4 | 5 => ctx.accounts.config.quorum_param_bps,
            _ => return err!(GovError::InvalidProposalType),
        };

        let total_votes =
            (ctx.accounts.proposal.votes_for + ctx.accounts.proposal.votes_against) as u128;
        let excluded =
            excluded_amount(&ctx.accounts.config, ctx.accounts.quorum_excluded.as_deref())?;
        require!(
            quorum_met(total_votes, supply, excluded, quorum_bps),
            GovError::QuorumNotReached
        );
        require!(
            ctx.accounts.proposal.votes_for > ctx.accounts.proposal.votes_against,
            GovError::ProposalRejected
        );

        // Timelock — now for ALL types. Gives the community time to react
        // (e.g. impeach) before a decision takes effect, and a spend leaves.
        let unlock_at = ctx.accounts.proposal.deadline + ctx.accounts.config.timelock_secs;
        require!(now >= unlock_at, GovError::TimelockNotElapsed);

        // owners_authority executes; the president may step in only after
        // exec_fallback_secs of owner inaction (liveness fallback).
        require!(
            can_execute(
                &ctx.accounts.executor.key(),
                &ctx.accounts.config.owners_authority,
                &ctx.accounts.config.president,
                now,
                unlock_at,
                ctx.accounts.config.exec_fallback_secs
            ),
            GovError::NotOwner
        );

        // Money-moving proposals (SPEND, milestone deposit) can only be
        // executed once per spend_cooldown_secs — no back-to-back drains.
        if proposal_type == 0 || proposal_type == 6 {
            require!(
                spend_cooldown_ok(
                    ctx.accounts.config.last_spend_ts,
                    now,
                    ctx.accounts.config.spend_cooldown_secs
                ),
                GovError::SpendCooldown
            );
            ctx.accounts.config.last_spend_ts = now;
        }

        let amount = ctx.accounts.proposal.amount;
        let target = ctx.accounts.proposal.target;
        let param_key = ctx.accounts.proposal.param_key;

        match proposal_type {
            0 => {
                // SPEND — re-check the cap at execution time
                let treasury_balance = ctx.accounts.treasury.amount;
                require!((amount as u128) <= spend_cap(treasury_balance), GovError::ExceedsSpendCap);

                // The recipient has to be who the vote actually approved.
                let recipient = ctx
                    .accounts
                    .recipient_token_account
                    .as_ref()
                    .ok_or(error!(GovError::WrongRecipient))?;
                require_keys_eq!(recipient.owner, target, GovError::WrongRecipient);

                let mint_key = ctx.accounts.config.governance_mint;
                let seeds: &[&[u8]] =
                    &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
                let signer_seeds: &[&[&[u8]]] = &[seeds];

                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        TransferChecked {
                            from: ctx.accounts.treasury.to_account_info(),
                            mint: ctx.accounts.treasury_mint.to_account_info(),
                            to: recipient.to_account_info(),
                            authority: ctx.accounts.config.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    amount,
                    ctx.accounts.treasury_mint.decimals,
                )?;
            }
            1 => {
                require!(
                    target != ctx.accounts.config.finance_minister
                        && target != ctx.accounts.config.culture_minister,
                    GovError::RoleConflict
                );
                ctx.accounts.config.president = target;
            }
            2 => {
                require!(
                    target != ctx.accounts.config.president
                        && target != ctx.accounts.config.culture_minister,
                    GovError::RoleConflict
                );
                ctx.accounts.config.finance_minister = target;
            }
            3 => {
                require!(
                    target != ctx.accounts.config.president
                        && target != ctx.accounts.config.finance_minister,
                    GovError::RoleConflict
                );
                ctx.accounts.config.culture_minister = target;
            }
            4 => {
                check_param_bounds(param_key, amount)?;
                let cfg = &mut ctx.accounts.config;
                match param_key {
                    0 => cfg.voting_period_secs = amount as i64,
                    1 => cfg.proposal_threshold_bps = amount,
                    2 => cfg.quorum_spend_bps = amount,
                    3 => cfg.quorum_role_bps = amount,
                    4 => cfg.quorum_param_bps = amount,
                    5 => cfg.finance_daily_bps = amount,
                    6 => cfg.finance_weekly_bps = amount,
                    7 => cfg.culture_daily_bps = amount,
                    8 => cfg.culture_weekly_bps = amount,
                    9 => cfg.timelock_secs = amount as i64,
                    10 => cfg.payroll_president_bps = amount,
                    11 => cfg.payroll_finance_bps = amount,
                    12 => cfg.payroll_culture_bps = amount,
                    13 => cfg.spend_cooldown_secs = amount as i64,
                    14 => cfg.exec_fallback_secs = amount as i64,
                    _ => return err!(GovError::InvalidParamKey),
                }
            }
            5 => {
                // CHANGE_OWNERS_AUTHORITY — the most sensitive change.
                ctx.accounts.config.owners_authority = target;
            }
            6 => {
                // DEPOSIT_TO_MILESTONE_FUND — move part of the treasury into
                // the citizens' reward bucket, capped and voted-on.
                let treasury_balance = ctx.accounts.treasury.amount;
                let cap = (treasury_balance as u128)
                    * ctx.accounts.config.milestone_deposit_bps as u128
                    / BPS_DENOM as u128;
                require!((amount as u128) <= cap, GovError::ExceedsMilestoneDepositCap);

                let fund = ctx
                    .accounts
                    .milestone_fund
                    .as_ref()
                    .ok_or(error!(GovError::MilestoneFundMissing))?;
                require_keys_eq!(
                    fund.key(),
                    ctx.accounts.config.milestone_fund_token_account,
                    GovError::MilestoneFundMissing
                );

                let mint_key = ctx.accounts.config.governance_mint;
                let seeds: &[&[u8]] =
                    &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
                let signer_seeds: &[&[&[u8]]] = &[seeds];

                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        TransferChecked {
                            from: ctx.accounts.treasury.to_account_info(),
                            mint: ctx.accounts.treasury_mint.to_account_info(),
                            to: fund.to_account_info(),
                            authority: ctx.accounts.config.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    amount,
                    ctx.accounts.treasury_mint.decimals,
                )?;
            }
            _ => return err!(GovError::InvalidProposalType),
        }

        ctx.accounts.proposal.executed = true;
        Ok(())
    }

    /// Autonomous minister spend (finance/culture) — WITHOUT a vote, within
    /// rolling limits as a % of the MORNING treasury snapshot. Limits are
    /// tracked per ROLE (role 1 = finance, 2 = culture), so swapping the
    /// minister's wallet does not reset the window. `reason` is required
    /// (not checked for relevance — that restriction is reputational).
    pub fn minister_spend(
        ctx: Context<MinisterSpend>,
        role: u8,
        amount: u64,
        reason: String,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, GovError::Paused);
        require!(!reason.is_empty(), GovError::ReasonRequired);
        require!(reason.len() <= 200, GovError::ReasonTooLong);
        require!(role == 1 || role == 2, GovError::NotMinister);

        let signer = ctx.accounts.minister.key();
        let (daily_bps, weekly_bps) = if role == 1 {
            require_keys_eq!(signer, ctx.accounts.config.finance_minister, GovError::NotMinister);
            (
                ctx.accounts.config.finance_daily_bps,
                ctx.accounts.config.finance_weekly_bps,
            )
        } else {
            require_keys_eq!(signer, ctx.accounts.config.culture_minister, GovError::NotMinister);
            (
                ctx.accounts.config.culture_daily_bps,
                ctx.accounts.config.culture_weekly_bps,
            )
        };

        let now = Clock::get()?.unix_timestamp;
        let treasury_amount = ctx.accounts.treasury.amount;
        refresh_treasury_snapshot(&mut ctx.accounts.config, treasury_amount, now);
        let base = ctx.accounts.config.treasury_snapshot_amount as u128;

        let tracker = &mut ctx.accounts.spend_tracker;
        if now - tracker.daily_window_start >= SECONDS_PER_DAY {
            tracker.daily_window_start = now;
            tracker.daily_spent = 0;
        }
        if now - tracker.weekly_window_start >= SECONDS_PER_WEEK {
            tracker.weekly_window_start = now;
            tracker.weekly_spent = 0;
        }

        let daily_cap = base * daily_bps as u128 / BPS_DENOM as u128;
        let weekly_cap = base * weekly_bps as u128 / BPS_DENOM as u128;

        require!(
            (tracker.daily_spent as u128) + (amount as u128) <= daily_cap,
            GovError::ExceedsDailyLimit
        );
        require!(
            (tracker.weekly_spent as u128) + (amount as u128) <= weekly_cap,
            GovError::ExceedsWeeklyLimit
        );

        tracker.role = role;
        tracker.daily_spent = tracker.daily_spent.checked_add(amount).unwrap();
        tracker.weekly_spent = tracker.weekly_spent.checked_add(amount).unwrap();
        tracker.bump = ctx.bumps.spend_tracker;

        let mint_key = ctx.accounts.config.governance_mint;
        let seeds: &[&[u8]] = &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.treasury.to_account_info(),
                    mint: ctx.accounts.treasury_mint.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.treasury_mint.decimals,
        )?;
        Ok(())
    }

    /// One-time (owners_authority): link the Meteora DAMM v2 pool whose trading
    /// fee feeds the treasury. The pool must be governance_mint (token A) /
    /// treasury_mint (token B) in "fee only in B" mode, and the Config PDA must
    /// already hold the position NFT. Also fixes the pool's token-A vault as the
    /// account excluded from the voting base. Cannot be changed afterwards.
    pub fn register_pool(ctx: Context<RegisterPool>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owners_authority,
            GovError::NotOwner
        );
        require!(
            ctx.accounts.config.fee_pool == Pubkey::default(),
            GovError::PoolAlreadyRegistered
        );

        let pool_info = ctx.accounts.pool.to_account_info();
        require_keys_eq!(*pool_info.owner, METEORA_CP_AMM, GovError::PoolMismatch);
        let vault_a = {
            let data = pool_info.try_borrow_data()?;
            let mint_a = read_key_at(&data, POOL_TOKEN_A_MINT_OFFSET).ok_or(GovError::PoolMismatch)?;
            let mint_b = read_key_at(&data, POOL_TOKEN_B_MINT_OFFSET).ok_or(GovError::PoolMismatch)?;
            require_keys_eq!(mint_a, ctx.accounts.config.governance_mint, GovError::PoolMismatch);
            require_keys_eq!(mint_b, ctx.accounts.config.treasury_mint, GovError::PoolMismatch);
            require!(
                data.get(POOL_COLLECT_FEE_MODE_OFFSET) == Some(&COLLECT_FEE_ONLY_B),
                GovError::PoolMismatch
            );
            read_key_at(&data, POOL_TOKEN_A_VAULT_OFFSET).ok_or(GovError::PoolMismatch)?
        };

        let position_info = ctx.accounts.position.to_account_info();
        require_keys_eq!(*position_info.owner, METEORA_CP_AMM, GovError::PositionMismatch);
        let nft_mint = {
            let data = position_info.try_borrow_data()?;
            let pool_key = read_key_at(&data, POSITION_POOL_OFFSET).ok_or(GovError::PositionMismatch)?;
            require_keys_eq!(pool_key, ctx.accounts.pool.key(), GovError::PositionMismatch);
            read_key_at(&data, POSITION_NFT_MINT_OFFSET).ok_or(GovError::PositionMismatch)?
        };
        let nft = &ctx.accounts.position_nft_account;
        require_keys_eq!(nft.mint, nft_mint, GovError::PositionMismatch);
        require_keys_eq!(nft.owner, ctx.accounts.config.key(), GovError::PositionMismatch);
        require!(nft.amount == 1, GovError::PositionMismatch);

        let config = &mut ctx.accounts.config;
        config.fee_pool = ctx.accounts.pool.key();
        config.fee_position = ctx.accounts.position.key();
        config.fee_position_nft_account = nft.key();
        config.quorum_excluded_account = vault_a;
        Ok(())
    }

    /// Permissionless: pull the trading fee accrued on the pool position into the
    /// treasury. The Config PDA owns the position NFT, so it signs the Meteora
    /// `claim_position_fee` call itself; the destination is hard-wired to the
    /// treasury account, so whoever calls this can only ever help the treasury.
    /// Not pause-gated: it is an INFLOW, not a spend.
    pub fn claim_pool_fees(ctx: Context<ClaimPoolFees>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(cfg.fee_pool != Pubkey::default(), GovError::PoolNotRegistered);

        let mint_key = cfg.governance_mint;
        let seeds: &[&[u8]] = &[b"config", mint_key.as_ref(), &[cfg.bump]];

        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.position.key(), false),
            AccountMeta::new(ctx.accounts.fee_a_account.key(), false),
            AccountMeta::new(ctx.accounts.treasury.key(), false),
            AccountMeta::new(ctx.accounts.token_a_vault.key(), false),
            AccountMeta::new(ctx.accounts.token_b_vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.governance_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.treasury_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.position_nft_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.config.key(), true),
            AccountMeta::new_readonly(ctx.accounts.token_a_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_b_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.meteora_program.key(), false),
        ];
        let ix = Instruction {
            program_id: METEORA_CP_AMM,
            accounts: metas,
            data: CLAIM_POSITION_FEE_DISC.to_vec(),
        };
        let infos = [
            ctx.accounts.pool_authority.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.fee_a_account.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
            ctx.accounts.token_a_vault.to_account_info(),
            ctx.accounts.token_b_vault.to_account_info(),
            ctx.accounts.governance_mint.to_account_info(),
            ctx.accounts.treasury_mint.to_account_info(),
            ctx.accounts.position_nft_account.to_account_info(),
            ctx.accounts.config.to_account_info(),
            ctx.accounts.token_a_program.to_account_info(),
            ctx.accounts.token_b_program.to_account_info(),
            ctx.accounts.event_authority.to_account_info(),
            ctx.accounts.meteora_program.to_account_info(),
        ];
        invoke_signed(&ix, &infos, &[seeds])?;
        Ok(())
    }

    /// One-time: create the Milestone Fund token account (PDA) and record its
    /// address in Config. Call after `initialize` if milestones will be used.
    pub fn setup_milestone_fund(ctx: Context<SetupMilestoneFund>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owners_authority,
            GovError::NotOwner
        );
        ctx.accounts.config.milestone_fund_token_account = ctx.accounts.milestone_fund.key();
        Ok(())
    }

    /// Owners declare a new milestone. The payout percentage locks in right
    /// away (min(30% + 5%*(n-1), 50%)); the base is frozen later in
    /// finalize_milestone.
    pub fn create_milestone(ctx: Context<CreateMilestone>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owners_authority,
            GovError::NotOwner
        );
        let n = ctx.accounts.config.next_milestone_number;

        let record = &mut ctx.accounts.milestone_record;
        record.milestone_number = n;
        record.payout_bps = payout_bps_for(n);
        record.total_eligible_weight = 0;
        record.fund_snapshot_amount = 0;
        record.finalized = false;
        record.finalized_at = 0;
        record.claimed_amount = 0;
        record.released = false;
        record.created_at = Clock::get()?.unix_timestamp;
        record.bump = ctx.bumps.milestone_record;

        ctx.accounts.config.next_milestone_number = n + 1;
        Ok(())
    }

    /// Manual "citizen" snapshot for a milestone. Weight must equal the
    /// holder's real balance and be >= citizenship_threshold_bps of supply.
    pub fn post_milestone_snapshot(
        ctx: Context<PostMilestoneSnapshot>,
        _milestone_number: u64,
        holder: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owners_authority,
            GovError::NotOwner
        );
        require!(!ctx.accounts.milestone_record.finalized, GovError::MilestoneFinalized);

        let weight = ctx.accounts.holder_token_account.amount;
        let supply = ctx.accounts.governance_mint.supply as u128;
        let threshold_bps = ctx.accounts.config.citizenship_threshold_bps as u128;
        require!(
            (weight as u128) * BPS_DENOM as u128 >= supply * threshold_bps,
            GovError::BelowCitizenshipThreshold
        );

        let snap = &mut ctx.accounts.milestone_snapshot;
        snap.milestone_number = ctx.accounts.milestone_record.milestone_number;
        snap.holder = holder;
        snap.weight = weight;
        snap.claimed = false;
        snap.bump = ctx.bumps.milestone_snapshot;

        ctx.accounts.milestone_record.total_eligible_weight = ctx
            .accounts
            .milestone_record
            .total_eligible_weight
            .checked_add(weight as u128)
            .unwrap();
        Ok(())
    }

    /// Freezes the payout base and reserves the pool so a later milestone
    /// cannot promise the same coins. Base = milestone_fund balance minus
    /// what earlier milestones still owe (config.milestone_reserved).
    pub fn finalize_milestone(
        ctx: Context<FinalizeMilestone>,
        _milestone_number: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owners_authority,
            GovError::NotOwner
        );
        require!(!ctx.accounts.milestone_record.finalized, GovError::MilestoneFinalized);
        require!(
            ctx.accounts.milestone_record.total_eligible_weight > 0,
            GovError::NothingToClaim
        );
        check_previous_milestone(
            ctx.accounts.milestone_record.milestone_number,
            ctx.accounts.previous_milestone.as_ref().map(|a| &**a),
        )?;

        let available = ctx
            .accounts
            .milestone_fund
            .amount
            .saturating_sub(ctx.accounts.config.milestone_reserved);
        let pool = milestone_pool(available, ctx.accounts.milestone_record.payout_bps);

        ctx.accounts.milestone_record.finalized = true;
        ctx.accounts.milestone_record.finalized_at = Clock::get()?.unix_timestamp;
        ctx.accounts.milestone_record.fund_snapshot_amount = available;
        ctx.accounts.config.milestone_reserved = ctx
            .accounts
            .config
            .milestone_reserved
            .checked_add(pool as u64)
            .unwrap();
        Ok(())
    }

    /// Closes a milestone after the claim grace period: whatever was promised
    /// but not paid out returns to the fund's free balance (the reserve is
    /// released), so the next milestone can use it. Claims on a closed
    /// milestone are no longer possible. owners_authority only.
    pub fn release_milestone_reserve(
        ctx: Context<ReleaseMilestone>,
        _milestone_number: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owners_authority,
            GovError::NotOwner
        );
        let rec = &ctx.accounts.milestone_record;
        require!(rec.finalized, GovError::MilestoneNotFinalized);
        require!(!rec.released, GovError::MilestoneClosed);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= rec.finalized_at.saturating_add(ctx.accounts.config.milestone_grace_secs),
            GovError::MilestoneGraceNotElapsed
        );

        let pool = milestone_pool(rec.fund_snapshot_amount, rec.payout_bps);
        let unclaimed = milestone_unclaimed(pool, rec.claimed_amount);
        ctx.accounts.config.milestone_reserved =
            ctx.accounts.config.milestone_reserved.saturating_sub(unclaimed);
        ctx.accounts.milestone_record.released = true;
        Ok(())
    }

    /// Pays a citizen their share. No signature from the citizen required —
    /// the team pushes each payout to the recorded holder's ATA. Once per
    /// milestone, only after finalize_milestone.
    /// share = (fund_snapshot * payout_bps / 10000) * (weight / total_weight)
    pub fn claim_milestone(
        ctx: Context<ClaimMilestone>,
        _milestone_number: u64,
        _holder: Pubkey,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, GovError::Paused);
        require!(ctx.accounts.milestone_record.finalized, GovError::MilestoneNotFinalized);
        require!(!ctx.accounts.milestone_record.released, GovError::MilestoneClosed);
        require!(!ctx.accounts.milestone_snapshot.claimed, GovError::AlreadyClaimedMilestone);

        let pool = milestone_pool(
            ctx.accounts.milestone_record.fund_snapshot_amount,
            ctx.accounts.milestone_record.payout_bps,
        );
        let share = milestone_share(
            pool,
            ctx.accounts.milestone_snapshot.weight as u128,
            ctx.accounts.milestone_record.total_eligible_weight,
        );
        require!(share > 0, GovError::NothingToClaim);

        ctx.accounts.milestone_snapshot.claimed = true;
        ctx.accounts.milestone_record.claimed_amount = ctx
            .accounts
            .milestone_record
            .claimed_amount
            .checked_add(share)
            .unwrap();
        ctx.accounts.config.milestone_reserved =
            ctx.accounts.config.milestone_reserved.saturating_sub(share);

        let mint_key = ctx.accounts.config.governance_mint;
        let seeds: &[&[u8]] = &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.milestone_fund.to_account_info(),
                    mint: ctx.accounts.treasury_mint.to_account_info(),
                    to: ctx.accounts.claimant_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            share,
            ctx.accounts.treasury_mint.decimals,
        )?;
        Ok(())
    }
}

// ==================== Accounts ====================
//
// Convention: `governance_mint` is the voting coin, `treasury_mint` the asset the
// treasury holds. Instructions that move money take `treasury_mint` (for the
// decimals) and `token_program` = the TREASURY asset's token program. Config
// is derived from the governance mint, stored inside Config.

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub governance_mint: Box<InterfaceAccount<'info, Mint>>,

    pub treasury_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = owner,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config", governance_mint.key().as_ref()],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = treasury_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token program of the treasury asset.
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct ClaimSalary<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.treasury_mint)]
    pub treasury_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = claimant,
        space = 8 + PayrollClaim::INIT_SPACE,
        seeds = [b"payroll", config.key().as_ref(), claimant.key().as_ref()],
        bump
    )]
    pub payroll_claim: Box<Account<'info, PayrollClaim>>,

    #[account(mut, address = config.treasury_token_account)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub claimant_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(_proposal_id: u64, voter: Pubkey)]
pub struct PostVoterSnapshot<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [b"proposal", config.key().as_ref(), &_proposal_id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Account<'info, Proposal>,

    /// The voter's real token account — weight is read from here, not passed in.
    #[account(
        constraint = voter_token_account.mint == config.governance_mint @ GovError::SnapshotAccountMismatch,
        constraint = voter_token_account.owner == voter @ GovError::SnapshotAccountMismatch,
    )]
    pub voter_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        space = 8 + VoterSnapshot::INIT_SPACE,
        seeds = [b"voter_snapshot", proposal.key().as_ref(), voter.as_ref()],
        bump
    )]
    pub voter_snapshot: Account<'info, VoterSnapshot>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.governance_mint)]
    pub governance_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        constraint = creator_token_account.mint == governance_mint.key(),
        constraint = creator_token_account.owner == creator.key(),
    )]
    pub creator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = config.treasury_token_account)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The registered pool's governance-coin vault. Required once a pool is
    /// registered (its balance is excluded from the voting base); omit before.
    pub quorum_excluded: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    #[account(
        init,
        payer = creator,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [b"proposal", config.key().as_ref(), &config.proposal_count.to_le_bytes()],
        bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct Vote<'info> {
    pub voter: Signer<'info>,

    #[account(seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [b"proposal", config.key().as_ref(), &proposal_id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Account<'info, Proposal>,

    #[account(
        mut,
        seeds = [b"voter_snapshot", proposal.key().as_ref(), voter.key().as_ref()],
        bump = voter_snapshot.bump
    )]
    pub voter_snapshot: Account<'info, VoterSnapshot>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ExecuteProposal<'info> {
    pub executor: Signer<'info>, // owners_authority, or president after exec_fallback_secs

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.governance_mint)]
    pub governance_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = config.treasury_mint)]
    pub treasury_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [b"proposal", config.key().as_ref(), &proposal_id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(mut, address = config.treasury_token_account)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Recipient token account — required for SPEND (type 0). Owner is checked
    /// against proposal.target inside execute_proposal. Omit for other types.
    #[account(mut)]
    pub recipient_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The Milestone Fund — required for DEPOSIT_TO_MILESTONE_FUND (type 6).
    #[account(mut)]
    pub milestone_fund: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The registered pool's governance-coin vault (required once a pool is registered).
    pub quorum_excluded: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(role: u8)]
pub struct MinisterSpend<'info> {
    #[account(mut)]
    pub minister: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.treasury_mint)]
    pub treasury_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = minister,
        space = 8 + SpendTracker::INIT_SPACE,
        seeds = [b"spend_tracker", config.key().as_ref(), &[role]],
        bump
    )]
    pub spend_tracker: Box<Account<'info, SpendTracker>>,

    #[account(mut, address = config.treasury_token_account)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterPool<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.governance_mint)]
    pub governance_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: a Meteora cp-amm pool; owner program, mints and fee mode are
    /// verified from its raw data inside register_pool.
    pub pool: UncheckedAccount<'info>,

    /// CHECK: a Meteora cp-amm position; owner program and pool link are verified.
    pub position: UncheckedAccount<'info>,

    /// The token account holding the position NFT; its authority must be the Config PDA.
    pub position_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Governance-coin account owned by the Config PDA: the (normally empty)
    /// "token A" destination Meteora's claim instruction insists on.
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = governance_mint,
        associated_token::authority = config,
        associated_token::token_program = governance_token_program,
    )]
    pub fee_a_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub governance_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimPoolFees<'info> {
    /// Anyone; only pays the transaction fee.
    pub caller: Signer<'info>,

    #[account(seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.governance_mint)]
    pub governance_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = config.treasury_mint)]
    pub treasury_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The ONLY place the fee can go.
    #[account(mut, address = config.treasury_token_account)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = governance_mint,
        associated_token::authority = config,
        associated_token::token_program = token_a_program,
    )]
    pub fee_a_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Meteora pool authority PDA (validated by Meteora).
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: the registered pool.
    #[account(address = config.fee_pool)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: the registered position.
    #[account(mut, address = config.fee_position)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: pool vault A (Meteora checks it against the pool).
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: pool vault B (Meteora checks it against the pool).
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// CHECK: the position NFT account held by the Config PDA.
    #[account(address = config.fee_position_nft_account)]
    pub position_nft_account: UncheckedAccount<'info>,

    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,

    /// CHECK: cp-amm event authority PDA (validated by Meteora).
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: the Meteora cp-amm program.
    #[account(address = METEORA_CP_AMM)]
    pub meteora_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetupMilestoneFund<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.treasury_mint)]
    pub treasury_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = owner,
        token::mint = treasury_mint,
        token::authority = config,
        token::token_program = token_program,
        seeds = [b"milestone_fund", config.key().as_ref()],
        bump
    )]
    pub milestone_fund: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMilestone<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = owner,
        space = 8 + MilestoneRecord::INIT_SPACE,
        seeds = [b"milestone", config.key().as_ref(), &config.next_milestone_number.to_le_bytes()],
        bump
    )]
    pub milestone_record: Account<'info, MilestoneRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(_milestone_number: u64, holder: Pubkey)]
pub struct PostMilestoneSnapshot<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.governance_mint)]
    pub governance_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"milestone", config.key().as_ref(), &_milestone_number.to_le_bytes()],
        bump = milestone_record.bump
    )]
    pub milestone_record: Box<Account<'info, MilestoneRecord>>,

    /// The holder's real token account — weight is read from here.
    #[account(
        constraint = holder_token_account.mint == config.governance_mint @ GovError::SnapshotAccountMismatch,
        constraint = holder_token_account.owner == holder @ GovError::SnapshotAccountMismatch,
    )]
    pub holder_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = owner,
        space = 8 + MilestoneSnapshot::INIT_SPACE,
        seeds = [b"milestone_snap", milestone_record.key().as_ref(), holder.as_ref()],
        bump
    )]
    pub milestone_snapshot: Box<Account<'info, MilestoneSnapshot>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(milestone_number: u64)]
pub struct FinalizeMilestone<'info> {
    pub owner: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"milestone", config.key().as_ref(), &milestone_number.to_le_bytes()],
        bump = milestone_record.bump
    )]
    pub milestone_record: Account<'info, MilestoneRecord>,

    /// Required when finalizing milestone 2+. Must be the immediately
    /// previous record. Omit for milestone 1.
    #[account(
        seeds = [
            b"milestone",
            config.key().as_ref(),
            &milestone_number.checked_sub(1).unwrap_or(0).to_le_bytes()
        ],
        bump = previous_milestone.bump,
    )]
    pub previous_milestone: Option<Account<'info, MilestoneRecord>>,

    #[account(
        seeds = [b"milestone_fund", config.key().as_ref()],
        bump
    )]
    pub milestone_fund: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(milestone_number: u64)]
pub struct ReleaseMilestone<'info> {
    pub owner: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"milestone", config.key().as_ref(), &milestone_number.to_le_bytes()],
        bump = milestone_record.bump
    )]
    pub milestone_record: Box<Account<'info, MilestoneRecord>>,
}

#[derive(Accounts)]
#[instruction(milestone_number: u64, holder: Pubkey)]
pub struct ClaimMilestone<'info> {
    /// Whoever submits + pays the tx fee (on practice: owners). The citizen
    /// does not sign — the payout is pushed to their recorded ATA.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [b"config", config.governance_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.treasury_mint)]
    pub treasury_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [b"milestone", config.key().as_ref(), &milestone_number.to_le_bytes()], bump = milestone_record.bump)]
    pub milestone_record: Box<Account<'info, MilestoneRecord>>,

    #[account(
        mut,
        seeds = [b"milestone_snap", milestone_record.key().as_ref(), holder.as_ref()],
        bump = milestone_snapshot.bump
    )]
    pub milestone_snapshot: Box<Account<'info, MilestoneSnapshot>>,

    #[account(
        mut,
        seeds = [b"milestone_fund", config.key().as_ref()],
        bump
    )]
    pub milestone_fund: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = claimant_token_account.mint == config.treasury_mint @ GovError::WrongRecipient,
        constraint = claimant_token_account.owner == holder @ GovError::WrongRecipient,
    )]
    pub claimant_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ==================== State ====================

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub owners_authority: Pubkey,
    pub admin_authority: Pubkey,
    pub president: Pubkey,
    pub finance_minister: Pubkey,
    pub culture_minister: Pubkey,
    /// The state's own voting coin (no transfer tax).
    pub governance_mint: Pubkey,
    /// The asset the treasury holds (the pool's quote asset: wSOL / USDC / USDT).
    pub treasury_mint: Pubkey,
    pub treasury_token_account: Pubkey,
    pub milestone_fund_token_account: Pubkey,
    /// Meteora pool / position / position-NFT account that feed the treasury (zero until register_pool).
    pub fee_pool: Pubkey,
    pub fee_position: Pubkey,
    pub fee_position_nft_account: Pubkey,
    /// Governance-coin account (the pool vault) excluded from the voting base; zero until register_pool.
    pub quorum_excluded_account: Pubkey,
    pub voting_period_secs: i64,
    pub proposal_threshold_bps: u64,
    pub quorum_spend_bps: u64,
    pub quorum_role_bps: u64,
    pub quorum_param_bps: u64,
    pub finance_daily_bps: u64,
    pub finance_weekly_bps: u64,
    pub culture_daily_bps: u64,
    pub culture_weekly_bps: u64,
    pub timelock_secs: i64,
    pub payroll_president_bps: u64,
    pub payroll_finance_bps: u64,
    pub payroll_culture_bps: u64,
    pub citizenship_threshold_bps: u64,
    pub milestone_deposit_bps: u64,
    pub spend_cooldown_secs: i64,
    pub exec_fallback_secs: i64,
    pub milestone_grace_secs: i64,
    pub last_spend_ts: i64,
    pub milestone_reserved: u64,
    pub treasury_snapshot_amount: u64,
    pub treasury_snapshot_day: i64,
    pub next_milestone_number: u64,
    pub proposal_count: u64,
    pub bump: u8,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub id: u64,
    /// 0=Spend 1=ChangePresident 2=AppointFinance 3=AppointCulture
    /// 4=ChangeParam 5=ChangeOwnersAuthority 6=DepositToMilestoneFund
    pub proposal_type: u8,
    pub creator: Pubkey,
    pub target: Pubkey,
    pub amount: u64,
    pub param_key: u8,
    #[max_len(200)]
    pub reason: String,
    pub votes_for: u64,
    pub votes_against: u64,
    pub created_at: i64,
    pub deadline: i64,
    pub executed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VoterSnapshot {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub weight: u64,
    pub consumed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SpendTracker {
    pub role: u8, // 1=finance 2=culture
    pub daily_window_start: i64,
    pub daily_spent: u64,
    pub weekly_window_start: i64,
    pub weekly_spent: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PayrollClaim {
    pub role: u8, // 0=president 1=finance 2=culture
    pub last_claim_ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MilestoneRecord {
    pub milestone_number: u64,
    pub payout_bps: u64,
    pub total_eligible_weight: u128,
    pub fund_snapshot_amount: u64,
    pub finalized: bool,
    pub finalized_at: i64,
    pub claimed_amount: u64,
    pub released: bool,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MilestoneSnapshot {
    pub milestone_number: u64,
    pub holder: Pubkey,
    pub weight: u64,
    pub claimed: bool,
    pub bump: u8,
}

// ==================== Errors ====================

#[error_code]
pub enum GovError {
    #[msg("Zero address not allowed")]
    ZeroAddress,
    #[msg("Only owners_authority can call this")]
    NotOwner,
    #[msg("Only admin_authority can call this")]
    NotAdmin,
    #[msg("Treasury outflows are paused")]
    Paused,
    #[msg("Reason exceeds max length")]
    ReasonTooLong,
    #[msg("Reason is required")]
    ReasonRequired,
    #[msg("Invalid proposal type")]
    InvalidProposalType,
    #[msg("Invalid param key")]
    InvalidParamKey,
    #[msg("Parameter value out of allowed bounds")]
    ParamOutOfBounds,
    #[msg("Creator balance below proposal threshold")]
    BelowThreshold,
    #[msg("Amount exceeds 30% treasury spend cap")]
    ExceedsSpendCap,
    #[msg("Amount exceeds milestone deposit cap")]
    ExceedsMilestoneDepositCap,
    #[msg("Amount exceeds treasury balance")]
    InsufficientTreasury,
    #[msg("Voting period still active")]
    ProposalNotActive,
    #[msg("Voting period already ended")]
    ProposalStillActive,
    #[msg("Proposal already executed")]
    AlreadyExecuted,
    #[msg("Cannot add snapshots after voting has started")]
    VotingAlreadyStarted,
    #[msg("Quorum not reached")]
    QuorumNotReached,
    #[msg("Timelock has not elapsed yet")]
    TimelockNotElapsed,
    #[msg("Another spend was executed too recently (spend cooldown)")]
    SpendCooldown,
    #[msg("Signer is not eligible for payroll (not president/minister)")]
    NotEligibleForPayroll,
    #[msg("Salary already claimed today")]
    PayrollTooSoon,
    #[msg("Nothing to claim (bps is 0 or balance empty)")]
    NothingToClaim,
    #[msg("Proposal did not pass (against >= for)")]
    ProposalRejected,
    #[msg("This snapshot does not belong to you")]
    NotYourSnapshot,
    #[msg("Snapshot token account does not match the voter/holder or mint")]
    SnapshotAccountMismatch,
    #[msg("Already voted")]
    AlreadyVoted,
    #[msg("No voting weight registered")]
    NoWeight,
    #[msg("A role must be held by a distinct address")]
    RoleConflict,
    #[msg("Signer is not finance or culture minister")]
    NotMinister,
    #[msg("Recipient does not match the approved proposal target")]
    WrongRecipient,
    #[msg("Milestone fund account missing or mismatched")]
    MilestoneFundMissing,
    #[msg("Exceeds daily spend limit")]
    ExceedsDailyLimit,
    #[msg("Exceeds weekly spend limit")]
    ExceedsWeeklyLimit,
    #[msg("Holder weight below citizenship threshold")]
    BelowCitizenshipThreshold,
    #[msg("Milestone already finalized")]
    MilestoneFinalized,
    #[msg("Milestone not finalized yet")]
    MilestoneNotFinalized,
    #[msg("Invalid config parameter")]
    InvalidBps,
    #[msg("Previous milestone is missing or not yet finalized")]
    PreviousMilestoneNotFinalized,
    #[msg("Milestone reward already claimed")]
    AlreadyClaimedMilestone,
    #[msg("Milestone is closed (unclaimed part already returned to the fund)")]
    MilestoneClosed,
    #[msg("Claim grace period has not elapsed yet")]
    MilestoneGraceNotElapsed,
    #[msg("Fee pool is already registered")]
    PoolAlreadyRegistered,
    #[msg("Fee pool is not registered yet")]
    PoolNotRegistered,
    #[msg("Pool is not the governance/treasury pair in fee-only-B mode")]
    PoolMismatch,
    #[msg("Position does not belong to this pool or the Config PDA does not hold it")]
    PositionMismatch,
    #[msg("The registered pool vault must be passed to compute the voting base")]
    ExcludedAccountMissing,
}

/// Milestone N>1 may be finalized only after milestone N-1 is finalized.
pub fn check_previous_milestone(
    current_number: u64,
    previous: Option<&MilestoneRecord>,
) -> Result<()> {
    if current_number <= 1 {
        return Ok(());
    }
    let prev = previous.ok_or(error!(GovError::PreviousMilestoneNotFinalized))?;
    require!(prev.finalized, GovError::PreviousMilestoneNotFinalized);
    require!(
        prev.milestone_number.checked_add(1) == Some(current_number),
        GovError::PreviousMilestoneNotFinalized
    );
    Ok(())
}

#[cfg(test)]
mod p0_tests {
    use super::*;

    fn record(number: u64, finalized: bool) -> MilestoneRecord {
        MilestoneRecord {
            milestone_number: number,
            payout_bps: 3_000,
            total_eligible_weight: 1,
            fund_snapshot_amount: 0,
            finalized,
            finalized_at: 0,
            claimed_amount: 0,
            released: false,
            created_at: 0,
            bump: 0,
        }
    }

    #[test]
    fn first_milestone_does_not_need_previous() {
        assert!(check_previous_milestone(1, None).is_ok());
        assert!(check_previous_milestone(0, None).is_ok());
    }

    #[test]
    fn second_milestone_requires_finalized_predecessor() {
        assert!(check_previous_milestone(2, None).is_err());
        assert!(check_previous_milestone(2, Some(&record(1, false))).is_err());
        assert!(check_previous_milestone(2, Some(&record(1, true))).is_ok());
        assert!(check_previous_milestone(2, Some(&record(3, true))).is_err());
    }

    // ---- voting base / quorum ----

    #[test]
    fn voting_base_excludes_pool_vault() {
        assert_eq!(voting_base(1_000, 400), 600);
        assert_eq!(voting_base(1_000, 0), 1_000); // no pool registered
        // an excluded balance bigger than supply can't happen, but must not panic
        assert_eq!(voting_base(1_000, 5_000), 0);
    }

    #[test]
    fn quorum_boundary() {
        // base = 1000 - 0 = 1000, quorum 10% => need >= 100
        assert!(!quorum_met(99, 1_000, 0, 1_000));
        assert!(quorum_met(100, 1_000, 0, 1_000));
        // half the coins sit in the pool vault: base = 500 => need >= 50
        assert!(quorum_met(50, 1_000, 500, 1_000));
        assert!(!quorum_met(49, 1_000, 500, 1_000));
    }

    #[test]
    fn reads_keys_out_of_foreign_account_data() {
        let mut data = vec![0u8; 300];
        let k = Pubkey::new_unique();
        data[168..200].copy_from_slice(k.as_ref());
        assert_eq!(read_key_at(&data, POOL_TOKEN_A_MINT_OFFSET), Some(k));
        assert_eq!(read_key_at(&data, 269), None); // runs past the end
        assert_eq!(read_key_at(&data, usize::MAX), None); // offset overflow
        assert_eq!(read_key_at(&[], 0), None);
    }

    #[test]
    fn cp_amm_layout_offsets_are_consistent() {
        // mints and vaults sit back to back (32 bytes each) right after the fee struct
        assert_eq!(POOL_TOKEN_B_MINT_OFFSET, POOL_TOKEN_A_MINT_OFFSET + 32);
        assert_eq!(POOL_TOKEN_A_VAULT_OFFSET, POOL_TOKEN_B_MINT_OFFSET + 32);
        assert_eq!(POOL_TOKEN_B_VAULT_OFFSET, POOL_TOKEN_A_VAULT_OFFSET + 32);
        assert_eq!(POSITION_NFT_MINT_OFFSET, POSITION_POOL_OFFSET + 32);
    }

    #[test]
    fn spend_cap_is_30pct() {
        assert_eq!(spend_cap(1_000), 300);
        assert_eq!(spend_cap(0), 0);
    }

    #[test]
    fn executor_rules() {
        let owners = Pubkey::new_unique();
        let pres = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        // owners always ok
        assert!(can_execute(&owners, &owners, &pres, 100, 100, 86_400));
        // president too early
        assert!(!can_execute(&pres, &owners, &pres, 100 + 86_399, 100, 86_400));
        // president after the fallback window
        assert!(can_execute(&pres, &owners, &pres, 100 + 86_400, 100, 86_400));
        // random wallet never
        assert!(!can_execute(&other, &owners, &pres, 10_000_000, 100, 86_400));
    }

    #[test]
    fn spend_cooldown() {
        // never spent before — always ok
        assert!(spend_cooldown_ok(0, 1_000, 86_400));
        // spent 100s ago, cooldown 86400 — blocked
        assert!(!spend_cooldown_ok(900, 1_000, 86_400));
        // spent exactly cooldown ago — ok
        assert!(spend_cooldown_ok(1_000, 1_000 + 86_400, 86_400));
        // cooldown disabled (0) — always ok
        assert!(spend_cooldown_ok(999, 1_000, 0));
    }

    // ---- milestone math ----

    #[test]
    fn payout_bps_schedule() {
        assert_eq!(payout_bps_for(1), 3_000);
        assert_eq!(payout_bps_for(2), 3_500);
        assert_eq!(payout_bps_for(5), 5_000);
        assert_eq!(payout_bps_for(100), 5_000); // capped at 50%
    }

    #[test]
    fn milestone_pool_and_share() {
        let pool = milestone_pool(1_000, 3_000); // 30% of 1000
        assert_eq!(pool, 300);
        // two citizens, weights 3 and 1
        assert_eq!(milestone_share(pool, 3, 4), 225);
        assert_eq!(milestone_share(pool, 1, 4), 75);
        assert_eq!(milestone_share(pool, 1, 0), 0); // no div-by-zero
    }

    #[test]
    fn unclaimed_returns_to_fund() {
        let pool = milestone_pool(1_000, 3_000); // 300
        assert_eq!(milestone_unclaimed(pool, 225), 75);
        assert_eq!(milestone_unclaimed(pool, 300), 0);
        assert_eq!(milestone_unclaimed(pool, 999), 0); // never underflows
    }

    #[test]
    fn milestone_reserve_prevents_double_promise() {
        // fund has 1000, milestone 1 reserves 30% = 300
        let reserved_after_1: u64 = milestone_pool(1_000, payout_bps_for(1)) as u64;
        assert_eq!(reserved_after_1, 300);
        // milestone 2 base excludes the reserve: available = 1000 - 300 = 700
        let available_2 = 1_000u64.saturating_sub(reserved_after_1);
        assert_eq!(available_2, 700);
        let pool_2 = milestone_pool(available_2, payout_bps_for(2)); // 35% of 700
        assert_eq!(pool_2, 245);
        // total promised never exceeds the fund
        assert!(reserved_after_1 as u128 + pool_2 <= 1_000);
    }

    // ---- param bounds ----

    #[test]
    fn param_bounds_reject_zeroing_governance() {
        assert!(check_param_bounds(0, 0).is_err()); // voting period 0
        assert!(check_param_bounds(2, 0).is_err()); // quorum 0
        assert!(check_param_bounds(1, 0).is_err()); // threshold 0
    }

    #[test]
    fn param_bounds_reject_out_of_range() {
        assert!(check_param_bounds(2, BPS_DENOM + 1).is_err()); // quorum > 100%
        assert!(check_param_bounds(10, MAX_PAYROLL_BPS + 1).is_err()); // payroll too high
        assert!(check_param_bounds(5, MAX_MINISTER_BPS + 1).is_err()); // minister limit too high
        assert!(check_param_bounds(9, u64::MAX).is_err()); // timelock i64 overflow
        assert!(check_param_bounds(0, (MAX_VOTING_PERIOD_SECS as u64) + 1).is_err());
        assert!(check_param_bounds(13, (MAX_SPEND_COOLDOWN_SECS as u64) + 1).is_err());
        assert!(check_param_bounds(14, 60).is_err()); // fallback < 1h
        assert!(check_param_bounds(15, 1).is_err()); // unknown key
    }

    #[test]
    fn param_bounds_accept_sane_values() {
        assert!(check_param_bounds(0, 86_400).is_ok()); // 1 day voting
        assert!(check_param_bounds(2, 1_000).is_ok()); // 10% quorum
        assert!(check_param_bounds(9, 0).is_ok()); // zero timelock allowed
        assert!(check_param_bounds(10, 50).is_ok()); // 0.5%/day payroll
        assert!(check_param_bounds(13, 86_400).is_ok()); // 1-day spend cooldown
        assert!(check_param_bounds(14, 86_400).is_ok()); // 1-day president fallback
    }

    // ---- treasury snapshot ----

    #[test]
    fn snapshot_refreshes_once_per_day() {
        let mut cfg = Config {
            owners_authority: Pubkey::default(),
            admin_authority: Pubkey::default(),
            president: Pubkey::default(),
            finance_minister: Pubkey::default(),
            culture_minister: Pubkey::default(),
            governance_mint: Pubkey::default(),
            treasury_mint: Pubkey::default(),
            treasury_token_account: Pubkey::default(),
            milestone_fund_token_account: Pubkey::default(),
            fee_pool: Pubkey::default(),
            fee_position: Pubkey::default(),
            fee_position_nft_account: Pubkey::default(),
            quorum_excluded_account: Pubkey::default(),
            voting_period_secs: 0,
            proposal_threshold_bps: 0,
            quorum_spend_bps: 0,
            quorum_role_bps: 0,
            quorum_param_bps: 0,
            finance_daily_bps: 0,
            finance_weekly_bps: 0,
            culture_daily_bps: 0,
            culture_weekly_bps: 0,
            timelock_secs: 0,
            payroll_president_bps: 0,
            payroll_finance_bps: 0,
            payroll_culture_bps: 0,
            citizenship_threshold_bps: 0,
            milestone_deposit_bps: 0,
            spend_cooldown_secs: 0,
            exec_fallback_secs: 0,
            milestone_grace_secs: 0,
            last_spend_ts: 0,
            milestone_reserved: 0,
            treasury_snapshot_amount: 0,
            treasury_snapshot_day: 0,
            next_milestone_number: 1,
            proposal_count: 0,
            bump: 0,
            paused: false,
        };
        let day1 = 20_000 * SECONDS_PER_DAY + 100;
        refresh_treasury_snapshot(&mut cfg, 1_000, day1);
        assert_eq!(cfg.treasury_snapshot_amount, 1_000);
        // same day, bigger balance (e.g. a fee claim) — snapshot must NOT move
        refresh_treasury_snapshot(&mut cfg, 5_000, day1 + 500);
        assert_eq!(cfg.treasury_snapshot_amount, 1_000);
        // next day — refreshes
        refresh_treasury_snapshot(&mut cfg, 5_000, day1 + SECONDS_PER_DAY);
        assert_eq!(cfg.treasury_snapshot_amount, 5_000);
    }
}
