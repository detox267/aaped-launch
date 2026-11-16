use crate::{
    processor::{config, count, launch, now, operator},
    reward_swap,
    state::*,
    token,
};
use solana_program::{
    account_info::AccountInfo,
    program_option::COption,
    pubkey::{pubkey, Pubkey},
};
pub const MOONZ: Pubkey = pubkey!("DfUWVvq1NDip9EQT9RreVDTQL3kArLJkwq7e9LXZEfkh");
pub(crate) fn mint(a: &AccountInfo) -> Result<()> {
    require(
        *a.key == MOONZ && *a.owner == token::TOKEN,
        Error::InvalidMint,
    )?;
    let m = token::quote(a)?;
    require(
        m.decimals == 6 && m.mint_authority == COption::None && m.freeze_authority == COption::None,
        Error::InvalidMint,
    )
}
fn state(program: &Pubkey, a: &AccountInfo, launch: &Pubkey) -> Result<Rewards> {
    let s: Rewards = read(a, program, REWARDS_LEN)?;
    require(
        s.version == VERSION
            && s.launch == *launch
            && *a.key == Pubkey::find_program_address(&[REWARDS_SEED, launch.as_ref()], program).0,
        Error::InvalidAccount,
    )?;
    Ok(s)
}
fn moonz_launch(program: &Pubkey, a: &AccountInfo) -> Result<Launch> {
    let s = launch(program, a)?;
    require(
        s.version == MOONZ_LAUNCH_VERSION && s.remaining == 0 && s.deadline == 0,
        Error::InvalidState,
    )?;
    Ok(s)
}
// operator, config, launch, reward PDA, MOONZ mint, MOONZ ATA, token, ATA program, system
pub fn initialize(program: &Pubkey, a: &[AccountInfo]) -> Result<()> {
    count(a, 9)?;
    let cfg = config(program, &a[1])?;
    operator(&a[0], &cfg)?;
    moonz_launch(program, &a[2])?;
    mint(&a[4])?;
    let (key, bump) = Pubkey::find_program_address(&[REWARDS_SEED, a[2].key.as_ref()], program);
    require(
        *a[3].key == key && *a[6].key == token::TOKEN,
        Error::InvalidAccount,
    )?;
    token::create_pda(
        &a[0],
        &a[3],
        &a[8],
        program,
        REWARDS_LEN,
        &[REWARDS_SEED, a[2].key.as_ref(), &[bump]],
    )?;
    token::create_ata(&a[0], &a[5], &a[3], &a[4], &a[8], &a[6], &a[7])?;
    // Unsolicited MOONZ pre-funding is not assigned to a second payout round.
    write(
        &a[3],
        &Rewards {
            version: VERSION,
            launch: *a[2].key,
            available: 0,
            credited: 0,
            paid: 0,
            quote_spent: 0,
            round: 0,
            remaining: 0,
            deadline: 0,
            leaves: 0,
            root: [0; 32],
            bitmap: [0; 128],
        },
    )
}
// operator, config, launch, rewards, pair mint, launch pair ATA, MOONZ mint, rewards MOONZ ATA,
// rewards pair escrow ATA, market quote mint, rewards market-quote ATA, pair token program,
// standard token program, ATA program, system, [OG program + market accounts + optional Jupiter].
pub fn buy(
    program: &Pubkey,
    a: &[AccountInfo],
    amount: u64,
    min_bridge_out: u64,
    min_moonz_out: u64,
    deadline: u64,
    bridge_data: &[u8],
) -> Result<()> {
    require(a.len() >= 15, Error::InvalidAccount)?;
    let cfg = config(program, &a[1])?;
    operator(&a[0], &cfg)?;
    let mut l = moonz_launch(program, &a[2])?;
    let mut r = state(program, &a[3], a[2].key)?;
    let time = now()?;
    require(
        amount > 0 && min_moonz_out > 0 && deadline >= time && deadline <= add(time, 300)?,
        Error::InvalidAmount,
    )?;
    require(amount <= l.holder_available, Error::InsufficientBudget)?;
    // max_swap_raw is denominated in the launched base token, not the pair; it is not reused here.
    require(
        *a[4].key == l.quote
            && *a[4].owner == l.quote_program
            && *a[11].key == l.quote_program
            && *a[12].key == token::TOKEN,
        Error::InvalidMint,
    )?;
    token::quote(&a[4])?;
    mint(&a[6])?;
    let pair_before = token::vault(&a[5], &l.quote, a[2].key, &l.quote_program)?;
    let moonz_before = token::vault(&a[7], &MOONZ, a[3].key, &token::TOKEN)?;
    require(
        pair_before >= l.obligations()? && moonz_before >= r.obligations()?,
        Error::InsufficientBudget,
    )?;
    let bump = Pubkey::find_program_address(&[LAUNCH_SEED, l.base.as_ref()], program).1;
    let launch_seeds: &[&[u8]] = &[LAUNCH_SEED, l.base.as_ref(), &[bump]];
    if l.quote == MOONZ {
        count(a, 15)?;
        require(
            l.quote_program == token::TOKEN && bridge_data.is_empty() && min_bridge_out == 0,
            Error::InvalidRoute,
        )?;
        token::transfer(&a[5], &a[6], &a[7], &a[2], &a[12], amount, launch_seeds)?;
    } else {
        token::quote(&a[9])?;
        require(
            *a[9].owner == token::TOKEN
                && (*a[9].key == token::WSOL || *a[9].key == reward_swap::USDC),
            Error::InvalidMint,
        )?;
        token::create_ata(&a[0], &a[8], &a[3], &a[4], &a[14], &a[11], &a[13])?;
        token::create_ata(&a[0], &a[10], &a[3], &a[9], &a[14], &a[12], &a[13])?;
        let source_before = token::vault(&a[8], &l.quote, a[3].key, &l.quote_program)?;
        let bridge_before = token::vault(&a[10], a[9].key, a[3].key, &token::TOKEN)?;
        token::transfer(&a[5], &a[4], &a[8], &a[2], &a[11], amount, launch_seeds)?;
        let bump = Pubkey::find_program_address(&[REWARDS_SEED, a[2].key.as_ref()], program).1;
        let seeds: &[&[u8]] = &[REWARDS_SEED, a[2].key.as_ref(), &[bump]];
        let spend = if l.quote == *a[9].key {
            require(
                a.len() == 23
                    && a[8].key == a[10].key
                    && bridge_data.is_empty()
                    && min_bridge_out == 0,
                Error::InvalidRoute,
            )?;
            amount
        } else {
            require(a.len() >= 24 && min_bridge_out > 0, Error::InvalidRoute)?;
            reward_swap::bridge(program, a, bridge_data, amount, seeds)?;
            require(
                token::vault(&a[8], &l.quote, a[3].key, &l.quote_program)? == source_before,
                Error::InvalidAmount,
            )?;
            let received = sub(
                token::vault(&a[10], a[9].key, a[3].key, &token::TOKEN)?,
                bridge_before,
            )?;
            require(received >= min_bridge_out, Error::Slippage)?;
            received
        };
        reward_swap::buy(a, spend, min_moonz_out, seeds)?;
        // Neither pre-funded escrow nor another round's MOONZ can subsidize this purchase.
        require(
            token::vault(&a[8], &l.quote, a[3].key, &l.quote_program)? == source_before
                && token::vault(&a[10], a[9].key, a[3].key, &token::TOKEN)? == bridge_before,
            Error::InvalidAmount,
        )?;
    }
    require(
        token::vault(&a[5], &l.quote, a[2].key, &l.quote_program)? == sub(pair_before, amount)?,
        Error::InvalidAmount,
    )?;
    let received = sub(
        token::vault(&a[7], &MOONZ, a[3].key, &token::TOKEN)?,
        moonz_before,
    )?;
    require(received >= min_moonz_out, Error::Slippage)?;
    l.holder_available = sub(l.holder_available, amount)?;
    r.credit(received, amount)?; // no second platform deduction
    write(&a[2], &l)?;
    write(&a[3], &r)
}
// operator, config, launch, rewards
pub fn open(
    program: &Pubkey,
    a: &[AccountInfo],
    root: [u8; 32],
    total: u64,
    leaves: u32,
    deadline: u64,
) -> Result<()> {
    count(a, 4)?;
    operator(&a[0], &config(program, &a[1])?)?;
    moonz_launch(program, &a[2])?;
    let mut r = state(program, &a[3], a[2].key)?;
    r.open_round(root, total, leaves, deadline, now()?)?;
    write(&a[3], &r)
}
// config, launch, rewards, MOONZ mint, rewards MOONZ ATA, recipient wallet, recipient MOONZ ATA, token
pub fn pay(
    program: &Pubkey,
    a: &[AccountInfo],
    round: u64,
    index: u32,
    amount: u64,
    proof: &[[u8; 32]],
) -> Result<()> {
    count(a, 8)?;
    require(!config(program, &a[0])?.paused, Error::Paused)?;
    moonz_launch(program, &a[1])?;
    let mut r = state(program, &a[2], a[1].key)?;
    require(
        r.round == round && on_curve(a[5].key) && *a[7].key == token::TOKEN,
        Error::InvalidProof,
    )?;
    mint(&a[3])?;
    verify_proof(
        leaf(program, a[2].key, round, index, a[5].key, amount),
        proof,
        r.root,
    )?;
    let before = token::vault(&a[4], &MOONZ, a[2].key, &token::TOKEN)?;
    require(before >= r.obligations()?, Error::InsufficientBudget)?;
    let dest_before = token::vault(&a[6], &MOONZ, a[5].key, &token::TOKEN)?;
    r.mark_paid(index, amount, now()?)?;
    write(&a[2], &r)?;
    let bump = Pubkey::find_program_address(&[REWARDS_SEED, a[1].key.as_ref()], program).1;
    token::transfer(
        &a[4],
        &a[3],
        &a[6],
        &a[2],
        &a[7],
        amount,
        &[REWARDS_SEED, a[1].key.as_ref(), &[bump]],
    )?;
    require(
        token::vault(&a[4], &MOONZ, a[2].key, &token::TOKEN)? == sub(before, amount)?
            && token::vault(&a[6], &MOONZ, a[5].key, &token::TOKEN)? == add(dest_before, amount)?,
        Error::InvalidAmount,
    )
}
// launch, rewards; expiry rollover is permissionless, including while paused.
pub fn close(program: &Pubkey, a: &[AccountInfo]) -> Result<()> {
    count(a, 2)?;
    moonz_launch(program, &a[0])?;
    let mut r = state(program, &a[1], a[0].key)?;
    r.close_round(now()?)?;
    write(&a[1], &r)
}
