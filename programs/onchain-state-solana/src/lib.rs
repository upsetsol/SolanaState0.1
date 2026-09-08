use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        self, Mint, TokenAccount, TokenInterface, TransferChecked,
        HarvestWithheldTokensToMint, WithdrawWithheldTokensFromMint,
    },
};

declare_id!("FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy");

// ============================================================================
// v3 — governance/treasury hardening pass. Changes in this round:
//  * Vote weight is no longer a free-form number: post_voter_snapshot now
//    verifies it against the voter's REAL Token-2022 balance, and snapshots
//    can only be added BEFORE the first vote is cast (no adding voters
//    mid-count).
//  * Quorum / proposal-creation threshold are measured against
//    supply - treasury (coins actually in people's hands), so tax piling up
//    in the treasury does not silently raise the bar.
//  * Timelock now applies to EVERY proposal type, SPEND included.
//  * execute_proposal is owners_authority-only (was permissionless).
//  * President / finance minister / culture minister must be distinct.
//  * CHANGE_PARAM values are bounds-checked (see check_param_bounds).
//  * admin_authority (separate from owners_authority): can pause all
//    treasury outflows and adjust the citizenship threshold.
//  * Salary + minister limits are computed from a once-a-day "morning"
//    snapshot of the treasury, not the live balance — harvesting tax in the
//    afternoon can't bump today's spend caps.
//  * Minister spend limits are tracked per ROLE, not per wallet — swapping
//    the minister's key no longer resets the weekly window.
//  * Milestone Fund is topped up only through governance (proposal type 6)
//    and only up to milestone_deposit_bps of the treasury.
//  * Money-moving proposals (SPEND, milestone deposit) can only be EXECUTED
//    once per spend_cooldown_secs — you can't run several 30% spends
//    back-to-back to drain the treasury.
//  * Milestone payouts reserve their pool at finalize time
//    (config.milestone_reserved) so the same coins can't be promised to a
//    later milestone. claim_milestone no longer needs the citizen's
//    signature — the team pushes the payout to each citizen's ATA.
//  * All state accounts size themselves via #[derive(InitSpace)].
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
/// Max % of the morning treasury a role's salary can be set to, per day.
pub const MAX_PAYROLL_BPS: u64 = 100; // 1%/day
/// Max % of the morning treasury a minister daily/weekly limit can be set to.
pub const MAX_MINISTER_BPS: u64 = 2_000; // 20%
pub const MIN_QUORUM_BPS: u64 = 1;

// ==================== Pure helpers (unit-tested below) ====================

/// The base used for quorum / proposal-creation math: coins that are
/// actually circulating (total supply minus what sits in the treasury).
pub fn voting_base(supply: u128, treasury_amount: u64) -> u128 {
    supply.saturating_sub(treasury_amount as u128)
}

/// True when the votes cast clear the quorum bar against the circulating base.
pub fn quorum_met(total_votes: u128, supply: u128, treasury_amount: u64, quorum_bps: u64) -> bool {
    total_votes.saturating_mul(BPS_DENOM as u128)
        >= voting_base(supply, treasury_amount).saturating_mul(quorum_bps as u128)
}

/// 30%-of-treasury ceiling for a single SPEND proposal.
pub fn spend_cap(treasury_amount: u64) -> u128 {
    (treasury_amount as u128) * MAX_SPEND_BPS as u128 / BPS_DENOM as u128
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
    if param_key == 0 || param_key == 9 || param_key == 13 {
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

    /// Sets up Config + treasury (an ATA of governance_mint, owned by the Config PDA).
    /// `owners_authority` (typically a Squads vault) posts vote snapshots and
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
    ) -> Result<()> {
        require!(owners_authority != Pubkey::default(), GovError::ZeroAddress);
        require!(admin_authority != Pubkey::default(), GovError::ZeroAddress);
        require!(president != Pubkey::default(), GovError::ZeroAddress);
        require!(voting_period_secs > 0, GovError::InvalidBps);
        require!(timelock_secs >= 0, GovError::InvalidBps);
        require!(spend_cooldown_secs >= 0, GovError::InvalidBps);
        require!(citizenship_threshold_bps <= BPS_DENOM, GovError::InvalidBps);
        require!(milestone_deposit_bps <= BPS_DENOM, GovError::InvalidBps);

        let config = &mut ctx.accounts.config;
        config.owners_authority = owners_authority;
        config.admin_authority = admin_authority;
        config.president = president;
        config.finance_minister = Pubkey::default(); // vacant until APPOINT_ROLE
        config.culture_minister = Pubkey::default();
        config.governance_mint = ctx.accounts.governance_mint.key();
        config.treasury_token_account = ctx.accounts.treasury.key();
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

        let mint_key = ctx.accounts.governance_mint.key();
        let seeds: &[&[u8]] = &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.treasury.to_account_info(),
                    mint: ctx.accounts.governance_mint.to_account_info(),
                    to: ctx.accounts.claimant_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
            ctx.accounts.governance_mint.decimals,
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
    /// creator's LIVE balance against the circulating base (supply - treasury)
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
        let base = voting_base(supply, treasury_balance);
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
        require_keys_eq!(
            ctx.accounts.executor.key(),
            ctx.accounts.config.owners_authority,
            GovError::NotOwner
        );
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
        require!(
            quorum_met(total_votes, supply, ctx.accounts.treasury.amount, quorum_bps),
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

                let mint_key = ctx.accounts.governance_mint.key();
                let seeds: &[&[u8]] =
                    &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
                let signer_seeds: &[&[&[u8]]] = &[seeds];

                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        TransferChecked {
                            from: ctx.accounts.treasury.to_account_info(),
                            mint: ctx.accounts.governance_mint.to_account_info(),
                            to: recipient.to_account_info(),
                            authority: ctx.accounts.config.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    amount,
                    ctx.accounts.governance_mint.decimals,
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

                let mint_key = ctx.accounts.governance_mint.key();
                let seeds: &[&[u8]] =
                    &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
                let signer_seeds: &[&[&[u8]]] = &[seeds];

                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        TransferChecked {
                            from: ctx.accounts.treasury.to_account_info(),
                            mint: ctx.accounts.governance_mint.to_account_info(),
                            to: fund.to_account_info(),
                            authority: ctx.accounts.config.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    amount,
                    ctx.accounts.governance_mint.decimals,
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

        let mint_key = ctx.accounts.governance_mint.key();
        let seeds: &[&[u8]] = &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.treasury.to_account_info(),
                    mint: ctx.accounts.governance_mint.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.governance_mint.decimals,
        )?;
        Ok(())
    }

    /// Permissionless "cleanup" — collects the Token-2022 transfer-fee tax
    /// that piled up on the given accounts and sweeps it into the treasury.
    /// Not pause-gated: this is an INFLOW to the treasury, not a spend.
    pub fn harvest_fees<'a>(ctx: Context<'a, HarvestFees<'a>>) -> Result<()> {
        let source_accounts: Vec<AccountInfo> = ctx.remaining_accounts.to_vec();

        token_interface::harvest_withheld_tokens_to_mint(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                HarvestWithheldTokensToMint {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.governance_mint.to_account_info(),
                },
            ),
            source_accounts,
        )?;

        let mint_key = ctx.accounts.governance_mint.key();
        let seeds: &[&[u8]] = &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        token_interface::withdraw_withheld_tokens_from_mint(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            WithdrawWithheldTokensFromMint {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                mint: ctx.accounts.governance_mint.to_account_info(),
                destination: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        ))?;
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
        ctx.accounts.milestone_record.fund_snapshot_amount = available;
        ctx.accounts.config.milestone_reserved = ctx
            .accounts
            .config
            .milestone_reserved
            .checked_add(pool as u64)
            .unwrap();
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
        ctx.accounts.config.milestone_reserved =
            ctx.accounts.config.milestone_reserved.saturating_sub(share);

        let mint_key = ctx.accounts.governance_mint.key();
        let seeds: &[&[u8]] = &[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.milestone_fund.to_account_info(),
                    mint: ctx.accounts.governance_mint.to_account_info(),
                    to: ctx.accounts.claimant_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            share,
            ctx.accounts.governance_mint.decimals,
        )?;
        Ok(())
    }
}

// ==================== Accounts ====================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = owner,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config", governance_mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = governance_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

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

    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = claimant,
        space = 8 + PayrollClaim::INIT_SPACE,
        seeds = [b"payroll", config.key().as_ref(), claimant.key().as_ref()],
        bump
    )]
    pub payroll_claim: Account<'info, PayrollClaim>,

    #[account(
        mut,
        associated_token::mint = governance_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub claimant_token_account: InterfaceAccount<'info, TokenAccount>,

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

    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(
        constraint = creator_token_account.mint == governance_mint.key(),
        constraint = creator_token_account.owner == creator.key(),
    )]
    pub creator_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        associated_token::mint = governance_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [b"proposal", config.key().as_ref(), &config.proposal_count.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,

    pub token_program: Interface<'info, TokenInterface>,
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
    pub executor: Signer<'info>, // must be config.owners_authority

    pub governance_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [b"proposal", config.key().as_ref(), &proposal_id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        mut,
        associated_token::mint = governance_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Recipient token account — required for SPEND (type 0). Owner is checked
    /// against proposal.target inside execute_proposal. Omit for other types.
    #[account(mut)]
    pub recipient_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// The Milestone Fund — required for DEPOSIT_TO_MILESTONE_FUND (type 6).
    #[account(mut)]
    pub milestone_fund: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(role: u8)]
pub struct MinisterSpend<'info> {
    #[account(mut)]
    pub minister: Signer<'info>,

    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = minister,
        space = 8 + SpendTracker::INIT_SPACE,
        seeds = [b"spend_tracker", config.key().as_ref(), &[role]],
        bump
    )]
    pub spend_tracker: Account<'info, SpendTracker>,

    #[account(
        mut,
        associated_token::mint = governance_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct HarvestFees<'info> {
    #[account(mut)]
    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        associated_token::mint = governance_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: token accounts we're collecting the withheld fee from
}

#[derive(Accounts)]
pub struct SetupMilestoneFund<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = owner,
        token::mint = governance_mint,
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

    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
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

    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"milestone", config.key().as_ref(), &_milestone_number.to_le_bytes()],
        bump = milestone_record.bump
    )]
    pub milestone_record: Account<'info, MilestoneRecord>,

    /// The holder's real token account — weight is read from here.
    #[account(
        constraint = holder_token_account.mint == config.governance_mint @ GovError::SnapshotAccountMismatch,
        constraint = holder_token_account.owner == holder @ GovError::SnapshotAccountMismatch,
    )]
    pub holder_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        space = 8 + MilestoneSnapshot::INIT_SPACE,
        seeds = [b"milestone_snap", milestone_record.key().as_ref(), holder.as_ref()],
        bump
    )]
    pub milestone_snapshot: Account<'info, MilestoneSnapshot>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(milestone_number: u64)]
pub struct FinalizeMilestone<'info> {
    pub owner: Signer<'info>,

    pub governance_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
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

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(milestone_number: u64, holder: Pubkey)]
pub struct ClaimMilestone<'info> {
    /// Whoever submits + pays the tx fee (on practice: owners). The citizen
    /// does not sign — the payout is pushed to their recorded ATA.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub governance_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [b"config", governance_mint.key().as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [b"milestone", config.key().as_ref(), &milestone_number.to_le_bytes()], bump = milestone_record.bump)]
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
        constraint = claimant_token_account.mint == config.governance_mint @ GovError::WrongRecipient,
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
    pub governance_mint: Pubkey,
    pub treasury_token_account: Pubkey,
    pub milestone_fund_token_account: Pubkey,
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
    fn voting_base_excludes_treasury() {
        assert_eq!(voting_base(1_000, 400), 600);
        // treasury bigger than supply can't happen, but must not panic
        assert_eq!(voting_base(1_000, 5_000), 0);
    }

    #[test]
    fn quorum_boundary() {
        // circulating base = 1000 - 0 = 1000, quorum 10% => need >= 100
        assert!(!quorum_met(99, 1_000, 0, 1_000));
        assert!(quorum_met(100, 1_000, 0, 1_000));
        // tax in treasury lowers the bar: base = 1000 - 500 = 500 => need >= 50
        assert!(quorum_met(50, 1_000, 500, 1_000));
        assert!(!quorum_met(49, 1_000, 500, 1_000));
    }

    // ---- spend cap ----

    #[test]
    fn spend_cap_is_30pct() {
        assert_eq!(spend_cap(1_000), 300);
        assert_eq!(spend_cap(0), 0);
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
        assert!(check_param_bounds(14, 1).is_err()); // unknown key
    }

    #[test]
    fn param_bounds_accept_sane_values() {
        assert!(check_param_bounds(0, 86_400).is_ok()); // 1 day voting
        assert!(check_param_bounds(2, 1_000).is_ok()); // 10% quorum
        assert!(check_param_bounds(9, 0).is_ok()); // zero timelock allowed
        assert!(check_param_bounds(10, 50).is_ok()); // 0.5%/day payroll
        assert!(check_param_bounds(13, 86_400).is_ok()); // 1-day spend cooldown
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
            treasury_token_account: Pubkey::default(),
            milestone_fund_token_account: Pubkey::default(),
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
        // same day, bigger balance (e.g. harvest) — snapshot must NOT move
        refresh_treasury_snapshot(&mut cfg, 5_000, day1 + 500);
        assert_eq!(cfg.treasury_snapshot_amount, 1_000);
        // next day — refreshes
        refresh_treasury_snapshot(&mut cfg, 5_000, day1 + SECONDS_PER_DAY);
        assert_eq!(cfg.treasury_snapshot_amount, 5_000);
    }
}
