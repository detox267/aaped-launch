use crate::{
    processor::{config, count, launch, now, operator},
    raydium, reward_swap, rewards,
    state::*,
    token,
};
use solana_program::{
    account_info::AccountInfo, program::invoke_signed, pubkey::Pubkey, system_program,
};

fn state(program: &Pubkey, a: &AccountInfo, launch: &Pubkey) -> Result<Policy> {
    let s: Policy = read(a, program, POLICY_LEN)?;
    require(
        s.version == VERSION
            && s.launch == *launch
            && *a.key == Pubkey::find_program_address(&[POLICY_SEED, launch.as_ref()], program).0,
        Error::InvalidAccount,
    )?;
    Ok(s)
}
fn v2(program: &Pubkey, a: &AccountInfo) -> Result<Launch> {
    let l = launch(program, a)?;
    require(
        l.version == MOONZ_LAUNCH_VERSION && l.deadline == 0 && l.remaining == 0,
        Error::InvalidState,
    )?;
    Ok(l)
}
fn bounded(amount: u64, min_out: u64, deadline: u64) -> Result<()> {
    let time = now()?;
    require(
        amount > 0 && min_out > 0 && deadline >= time && deadline <= add(time, 300)?,
        Error::InvalidAmount,
    )
}
// operator, config, launch, policy, base, policy base ATA, pair, policy pair ATA,
// MOONZ, policy MOONZ ATA, Token2022, pair token, token, ATA, system
pub fn initialize(program: &Pubkey, a: &[AccountInfo]) -> Result<()> {
    count(a, 15)?;
    operator(&a[0], &config(program, &a[1])?)?;
    let l = v2(program, &a[2])?;
    require(
        *a[4].key == l.base
            && *a[6].key == l.quote
            && *a[6].owner == l.quote_program
            && *a[10].key == token::TOKEN22
            && *a[11].key == l.quote_program
            && *a[12].key == token::TOKEN,
        Error::InvalidMint,
    )?;
    token::base(
        &a[4],
        &Pubkey::find_program_address(&[AUTH_SEED], program).0,
    )?;
    token::quote(&a[6])?;
    rewards::mint(&a[8])?;
    let (key, bump) = Pubkey::find_program_address(&[POLICY_SEED, a[2].key.as_ref()], program);
    require(*a[3].key == key, Error::InvalidAccount)?;
    token::create_pda(
        &a[0],
        &a[3],
        &a[14],
        program,
        POLICY_LEN,
        &[POLICY_SEED, a[2].key.as_ref(), &[bump]],
    )?;
    token::create_ata(&a[0], &a[5], &a[3], &a[4], &a[14], &a[10], &a[13])?;
    token::create_ata(&a[0], &a[7], &a[3], &a[6], &a[14], &a[11], &a[13])?;
    token::create_ata(&a[0], &a[9], &a[3], &a[8], &a[14], &a[12], &a[13])?;
    write(
        &a[3],
        &Policy {
            version: VERSION,
            launch: *a[2].key,
            base_pending: 0,
            base_bought: 0,
            base_burned: 0,
            holder_quote_spent: 0,
            prize_quote_available: 0,
            prize_quote_reserved: 0,
            prize_quote_spent: 0,
            prize_moonz_paid: 0,
            sequence: 0,
            prize_quote_released: 0,
        },
    )
}
// operator, config, launch, policy, base, pair, launch pair ATA, policy base ATA,
// policy pair ATA, Token2022, pair token, followed by the exact Raydium buy accounts.
pub fn buyback(
    program: &Pubkey,
    a: &[AccountInfo],
    route: u8,
    amount: u64,
    min_out: u64,
    deadline: u64,
) -> Result<()> {
    require(a.len() >= 11, Error::InvalidAccount)?;
    let cfg = config(program, &a[1])?;
    operator(&a[0], &cfg)?;
    let mut l = v2(program, &a[2])?;
    let mut p = state(program, &a[3], a[2].key)?;
    bounded(amount, min_out, deadline)?;
    require(amount <= l.holder_available, Error::InsufficientBudget)?;
    require(
        *a[4].key == l.base
            && *a[5].key == l.quote
            && *a[5].owner == l.quote_program
            && *a[9].key == token::TOKEN22
            && *a[10].key == l.quote_program,
        Error::InvalidMint,
    )?;
    token::base(
        &a[4],
        &Pubkey::find_program_address(&[AUTH_SEED], program).0,
    )?;
    token::quote(&a[5])?;
    let source = token::vault(&a[6], &l.quote, a[2].key, &l.quote_program)?;
    let base = token::vault(&a[7], &l.base, a[3].key, &token::TOKEN22)?;
    let pair = token::vault(&a[8], &l.quote, a[3].key, &l.quote_program)?;
    require(
        source >= l.obligations()? && base >= p.base_pending && pair >= p.prize_quote_available,
        Error::InsufficientBudget,
    )?;
    let bump = Pubkey::find_program_address(&[LAUNCH_SEED, l.base.as_ref()], program).1;
    token::transfer(
        &a[6],
        &a[5],
        &a[8],
        &a[2],
        &a[10],
        amount,
        &[LAUNCH_SEED, l.base.as_ref(), &[bump]],
    )?;
    raydium::buyback(
        program,
        &a[2],
        &a[3],
        &a[11..],
        &cfg,
        &l,
        route,
        amount,
        min_out,
    )?;
    require(
        token::vault(&a[6], &l.quote, a[2].key, &l.quote_program)? == sub(source, amount)?
            && token::vault(&a[8], &l.quote, a[3].key, &l.quote_program)? == pair,
        Error::InvalidAmount,
    )?;
    let received = sub(
        token::vault(&a[7], &l.base, a[3].key, &token::TOKEN22)?,
        base,
    )?;
    require(received >= min_out, Error::Slippage)?;
    l.holder_available = sub(l.holder_available, amount)?;
    p.holder_quote_spent = add(p.holder_quote_spent, amount)?;
    p.base_bought = add(p.base_bought, received)?;
    p.base_pending = add(p.base_pending, received)?;
    p.sequence = add(p.sequence, 1)?;
    write(&a[2], &l)?;
    write(&a[3], &p)
}
// operator, config, launch, policy, base mint, policy base ATA, Token2022
pub fn burn(program: &Pubkey, a: &[AccountInfo], amount: u64) -> Result<()> {
    count(a, 7)?;
    operator(&a[0], &config(program, &a[1])?)?;
    let l = v2(program, &a[2])?;
    let mut p = state(program, &a[3], a[2].key)?;
    require(
        amount > 0 && amount <= p.base_pending,
        Error::InsufficientBudget,
    )?;
    require(
        *a[4].key == l.base && *a[6].key == token::TOKEN22,
        Error::InvalidMint,
    )?;
    let mint = token::base(
        &a[4],
        &Pubkey::find_program_address(&[AUTH_SEED], program).0,
    )?;
    let before = token::vault(&a[5], &l.base, a[3].key, &token::TOKEN22)?;
    require(before >= p.base_pending, Error::InsufficientBudget)?;
    let bump = Pubkey::find_program_address(&[POLICY_SEED, a[2].key.as_ref()], program).1;
    invoke_signed(
        &spl_token_2022::instruction::burn_checked(
            &token::TOKEN22,
            a[5].key,
            a[4].key,
            a[3].key,
            &[],
            amount,
            mint.decimals,
        )?,
        &[a[5].clone(), a[4].clone(), a[3].clone(), a[6].clone()],
        &[&[POLICY_SEED, a[2].key.as_ref(), &[bump]]],
    )?;
    require(
        token::vault(&a[5], &l.base, a[3].key, &token::TOKEN22)? == sub(before, amount)?
            && token::mint(&a[4])?.supply == sub(mint.supply, amount)?,
        Error::InvalidAmount,
    )?;
    p.base_pending = sub(p.base_pending, amount)?;
    p.base_burned = add(p.base_burned, amount)?;
    p.sequence = add(p.sequence, 1)?;
    write(&a[3], &p)
}
// operator, config, launch, policy, pair mint, launch pair ATA, policy pair ATA, pair token
pub fn reserve(program: &Pubkey, a: &[AccountInfo], amount: u64) -> Result<()> {
    count(a, 8)?;
    operator(&a[0], &config(program, &a[1])?)?;
    let mut l = v2(program, &a[2])?;
    let mut p = state(program, &a[3], a[2].key)?;
    require(
        amount > 0 && amount <= l.platform_available,
        Error::InsufficientBudget,
    )?;
    require(
        *a[4].key == l.quote && *a[4].owner == l.quote_program && *a[7].key == l.quote_program,
        Error::InvalidMint,
    )?;
    token::quote(&a[4])?;
    let source = token::vault(&a[5], &l.quote, a[2].key, &l.quote_program)?;
    let dest = token::vault(&a[6], &l.quote, a[3].key, &l.quote_program)?;
    require(
        source >= l.obligations()? && dest >= p.prize_quote_available,
        Error::InsufficientBudget,
    )?;
    let bump = Pubkey::find_program_address(&[LAUNCH_SEED, l.base.as_ref()], program).1;
    token::transfer(
        &a[5],
        &a[4],
        &a[6],
        &a[2],
        &a[7],
        amount,
        &[LAUNCH_SEED, l.base.as_ref(), &[bump]],
    )?;
    require(
        token::vault(&a[5], &l.quote, a[2].key, &l.quote_program)? == sub(source, amount)?
            && token::vault(&a[6], &l.quote, a[3].key, &l.quote_program)? == add(dest, amount)?,
        Error::InvalidAmount,
    )?;
    l.platform_available = sub(l.platform_available, amount)?;
    l.paid_platform = add(l.paid_platform, amount)?;
    p.prize_quote_available = add(p.prize_quote_available, amount)?;
    p.prize_quote_reserved = add(p.prize_quote_reserved, amount)?;
    p.sequence = add(p.sequence, 1)?;
    write(&a[2], &l)?;
    write(&a[3], &p)
}
// Same first 15 + OG accounts as BuyMoonz, but authority/vaults are Policy; last
// two accounts are the original creator and their canonical MOONZ ATA.
pub fn prize(
    program: &Pubkey,
    a: &[AccountInfo],
    amount: u64,
    min_out: u64,
    deadline: u64,
) -> Result<()> {
    require(a.len() == 17 || a.len() == 25, Error::InvalidAccount)?;
    operator(&a[0], &config(program, &a[1])?)?;
    let l = v2(program, &a[2])?;
    let mut p = state(program, &a[3], a[2].key)?;
    bounded(amount, min_out, deadline)?;
    require(amount <= p.prize_quote_available, Error::InsufficientBudget)?;
    require(
        *a[4].key == l.quote
            && l.quote_program == token::TOKEN
            && *a[11].key == token::TOKEN
            && *a[12].key == token::TOKEN
            && *a[13].key == token::ATA
            && *a[14].key == system_program::ID,
        Error::UnsupportedQuote,
    )?;
    token::quote(&a[4])?;
    rewards::mint(&a[6])?;
    let creator = &a[a.len() - 2];
    let destination = &a[a.len() - 1];
    require(
        *creator.key == l.creator && on_curve(creator.key),
        Error::Unauthorized,
    )?;
    require(
        a[5].key == a[8].key && a[5].key == a[10].key && *a[9].key == l.quote,
        Error::InvalidRoute,
    )?;
    let pair = token::vault(&a[5], &l.quote, a[3].key, &token::TOKEN)?;
    let moonz = token::vault(&a[7], &rewards::MOONZ, a[3].key, &token::TOKEN)?;
    let dest = token::vault(destination, &rewards::MOONZ, creator.key, &token::TOKEN)?;
    require(pair >= p.prize_quote_available, Error::InsufficientBudget)?;
    let bump = Pubkey::find_program_address(&[POLICY_SEED, a[2].key.as_ref()], program).1;
    let seeds: &[&[u8]] = &[POLICY_SEED, a[2].key.as_ref(), &[bump]];
    let received = if l.quote == rewards::MOONZ {
        count(a, 17)?;
        amount
    } else {
        count(a, 25)?;
        reward_swap::buy(&a[..23], amount, min_out, seeds)?;
        sub(
            token::vault(&a[7], &rewards::MOONZ, a[3].key, &token::TOKEN)?,
            moonz,
        )?
    };
    require(received >= min_out, Error::Slippage)?;
    token::transfer(&a[7], &a[6], destination, &a[3], &a[12], received, seeds)?;
    require(
        token::vault(&a[5], &l.quote, a[3].key, &token::TOKEN)? == sub(pair, amount)?
            && token::vault(destination, &rewards::MOONZ, creator.key, &token::TOKEN)?
                == add(dest, received)?
            && token::vault(&a[7], &rewards::MOONZ, a[3].key, &token::TOKEN)?
                == if l.quote == rewards::MOONZ {
                    sub(moonz, amount)?
                } else {
                    moonz
                },
        Error::InvalidAmount,
    )?;
    p.prize_quote_available = sub(p.prize_quote_available, amount)?;
    p.prize_quote_spent = add(p.prize_quote_spent, amount)?;
    p.prize_moonz_paid = add(p.prize_moonz_paid, received)?;
    p.sequence = add(p.sequence, 1)?;
    write(&a[3], &p)
}

// Return unused platform-owned prize funds to the same launch's platform pot.
// It is not a donation: there is no holder credit and no second 25/75 split.
pub fn release(program: &Pubkey, a: &[AccountInfo], amount: u64) -> Result<()> {
    count(a, 8)?;
    operator(&a[0], &config(program, &a[1])?)?;
    let mut l = v2(program, &a[2])?;
    let mut p = state(program, &a[3], a[2].key)?;
    require(
        amount > 0 && amount <= p.prize_quote_available,
        Error::InsufficientBudget,
    )?;
    require(
        *a[4].key == l.quote && *a[4].owner == l.quote_program && *a[7].key == l.quote_program,
        Error::InvalidMint,
    )?;
    token::quote(&a[4])?;
    let dest = token::vault(&a[5], &l.quote, a[2].key, &l.quote_program)?;
    let source = token::vault(&a[6], &l.quote, a[3].key, &l.quote_program)?;
    require(
        dest >= l.obligations()? && source >= p.prize_quote_available,
        Error::InsufficientBudget,
    )?;
    let bump = Pubkey::find_program_address(&[POLICY_SEED, a[2].key.as_ref()], program).1;
    token::transfer(
        &a[6],
        &a[4],
        &a[5],
        &a[3],
        &a[7],
        amount,
        &[POLICY_SEED, a[2].key.as_ref(), &[bump]],
    )?;
    require(
        token::vault(&a[5], &l.quote, a[2].key, &l.quote_program)? == add(dest, amount)?
            && token::vault(&a[6], &l.quote, a[3].key, &l.quote_program)? == sub(source, amount)?,
        Error::InvalidAmount,
    )?;
    l.platform_available = add(l.platform_available, amount)?;
    l.paid_platform = sub(l.paid_platform, amount)?;
    p.prize_quote_available = sub(p.prize_quote_available, amount)?;
    p.prize_quote_released = add(p.prize_quote_released, amount)?;
    p.sequence = add(p.sequence, 1)?;
    write(&a[2], &l)?;
    write(&a[3], &p)
}
