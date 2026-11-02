use crate::{state::*, token};
use solana_program::{
    account_info::AccountInfo,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    pubkey::{pubkey, Pubkey},
    system_program,
};
pub const LAUNCHLAB: Pubkey = pubkey!("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
pub const CPMM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const INITIALIZE: [u8; 8] = [37, 190, 126, 222, 44, 154, 171, 17];
fn key(a: &AccountInfo, expected: Pubkey) -> Result<()> {
    require(*a.key == expected, Error::InvalidRoute)
}
fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}
fn field(data: &[u8], offset: usize) -> Result<Pubkey> {
    Ok(Pubkey::new_from_array(
        data.get(offset..offset + 32)
            .ok_or(Error::InvalidAccount)?
            .try_into()
            .unwrap(),
    ))
}
fn number(data: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(
        data.get(offset..offset + 8)
            .ok_or(Error::InvalidAccount)?
            .try_into()
            .unwrap(),
    ))
}
pub fn platform(a: &AccountInfo, cfg: &Config, tax: &Pubkey) -> Result<()> {
    require(
        *a.key == cfg.platform && *a.owner == LAUNCHLAB,
        Error::InvalidPlatform,
    )?;
    let d = a.try_borrow_data()?;
    require(
        d.len() == 944 && d[..8] == hashv(&[b"account:PlatformConfig"]).to_bytes()[..8],
        Error::InvalidPlatform,
    )?;
    require(
        number(&d, 80)? == 0
            && number(&d, 88)? == 0
            && number(&d, 96)? == 1_000_000
            && number(&d, 104)? == 0
            && number(&d, 720)? == 0
            && field(&d, 688)? == cfg.cp_config
            && field(&d, 728)? == *tax,
        Error::InvalidPlatform,
    )
}
pub fn launch_data(data: &[u8]) -> Result<()> {
    require(
        data.len() >= 8 && data[..8] == INITIALIZE,
        Error::InvalidRoute,
    )?;
    let mut i = 8;
    require(data.get(i) == Some(&6), Error::InvalidMint)?;
    i += 1;
    for max in [32usize, 10, 200] {
        let size = u32::from_le_bytes(
            data.get(i..i + 4)
                .ok_or(Error::InvalidAmount)?
                .try_into()
                .unwrap(),
        ) as usize;
        i += 4;
        require(size > 0 && size <= max, Error::InvalidAmount)?;
        std::str::from_utf8(data.get(i..i + size).ok_or(Error::InvalidAmount)?)
            .map_err(|_| Error::InvalidAmount)?;
        i += size;
    }
    require(data.len() == i + 62 && data[i] == 0, Error::InvalidAmount)?;
    require(
        number(data, i + 1)? == 1_000_000_000_000_000
            && number(data, i + 9)? == 650_000_000_000_000
            && number(data, i + 17)? > 0
            && data[i + 25] == 1,
        Error::InvalidAmount,
    )?;
    require(
        number(data, i + 26)? == 0 && number(data, i + 34)? == 0 && number(data, i + 42)? == 0,
        Error::InvalidAmount,
    )?;
    // SDK 0.2.74-alpha: OnlyTokenB=0; transfer fee option=Some; fixed 300bps with no cap.
    require(
        data[i + 50] == 0
            && data[i + 51] == 1
            && data[i + 52..i + 54] == 300u16.to_le_bytes()
            && number(data, i + 54)? == u64::MAX,
        Error::InvalidAmount,
    )
}
pub fn initialize<'a>(
    a: &[AccountInfo<'a>],
    payer: &Pubkey,
    cfg: &Config,
    tax: &Pubkey,
    data: Vec<u8>,
) -> Result<()> {
    require((15..=17).contains(&a.len()), Error::InvalidAccount)?;
    launch_data(&data)?;
    key(&a[0], *payer)?;
    key(&a[1], *payer)?;
    require(
        a[0].is_signer
            && a[6].is_signer
            && a[6].data_is_empty()
            && *a[6].owner == system_program::ID,
        Error::Unauthorized,
    )?;
    require(*a[2].owner == LAUNCHLAB, Error::InvalidAccount)?;
    platform(&a[3], cfg, tax)?;
    key(&a[4], pda(&[b"vault_auth_seed"], &LAUNCHLAB))?;
    key(
        &a[5],
        pda(&[b"pool", a[6].key.as_ref(), a[7].key.as_ref()], &LAUNCHLAB),
    )?;
    key(
        &a[8],
        pda(
            &[b"pool_vault", a[5].key.as_ref(), a[6].key.as_ref()],
            &LAUNCHLAB,
        ),
    )?;
    key(
        &a[9],
        pda(
            &[b"pool_vault", a[5].key.as_ref(), a[7].key.as_ref()],
            &LAUNCHLAB,
        ),
    )?;
    key(&a[10], token::TOKEN22)?;
    key(&a[11], *a[7].owner)?;
    key(&a[12], system_program::ID)?;
    key(&a[13], pda(&[b"__event_authority"], &LAUNCHLAB))?;
    key(&a[14], LAUNCHLAB)?;
    require(a[14].executable, Error::InvalidAccount)?;
    token::quote(&a[7])?;
    // Raydium validates global-config/quote binding and optional allow/curve-rule PDAs.
    let keys = a
        .iter()
        .enumerate()
        .map(|(i, x)| {
            if [0, 5, 6, 8, 9].contains(&i) {
                AccountMeta::new(*x.key, i == 0 || i == 6)
            } else {
                AccountMeta::new_readonly(*x.key, false)
            }
        })
        .collect();
    invoke(
        &Instruction {
            program_id: LAUNCHLAB,
            accounts: keys,
            data,
        },
        a,
    )?;
    token::base(&a[6], tax)?;
    Ok(())
}

// The explicit inputs mirror the audited CPI boundary; do not accept arbitrary serialized instructions.
#[allow(clippy::too_many_arguments)]
pub fn convert<'a>(
    program: &Pubkey,
    launch: &AccountInfo<'a>,
    a: &[AccountInfo<'a>],
    cfg: &Config,
    state: &Launch,
    route: u8,
    amount: u64,
    min_out: u64,
) -> Result<()> {
    let (id, writable, data): (Pubkey, Vec<usize>, Vec<u8>) = match route {
        0 => {
            require(a.len() == 18, Error::InvalidRoute)?;
            key(&a[0], *launch.key)?;
            key(&a[1], pda(&[b"vault_auth_seed"], &LAUNCHLAB))?;
            require(*a[2].owner == LAUNCHLAB, Error::InvalidRoute)?;
            key(&a[3], cfg.platform)?;
            key(&a[4], state.pool)?;
            require(*a[4].owner == LAUNCHLAB, Error::InvalidRoute)?;
            key(&a[5], token::ata(&state.base, launch.key, &token::TOKEN22))?;
            key(
                &a[6],
                token::ata(&state.quote, launch.key, &state.quote_program),
            )?;
            key(
                &a[7],
                pda(
                    &[b"pool_vault", state.pool.as_ref(), state.base.as_ref()],
                    &LAUNCHLAB,
                ),
            )?;
            key(
                &a[8],
                pda(
                    &[b"pool_vault", state.pool.as_ref(), state.quote.as_ref()],
                    &LAUNCHLAB,
                ),
            )?;
            key(&a[9], state.base)?;
            key(&a[10], state.quote)?;
            key(&a[11], token::TOKEN22)?;
            key(&a[12], state.quote_program)?;
            key(&a[13], pda(&[b"__event_authority"], &LAUNCHLAB))?;
            key(&a[14], LAUNCHLAB)?;
            key(&a[15], system_program::ID)?;
            key(
                &a[16],
                pda(&[cfg.platform.as_ref(), state.quote.as_ref()], &LAUNCHLAB),
            )?;
            key(
                &a[17],
                pda(&[state.creator.as_ref(), state.quote.as_ref()], &LAUNCHLAB),
            )?;
            // Recheck platform fees at conversion too; a changed platform cannot silently add Moonz fees.
            platform(&a[3], cfg, &pda(&[AUTH_SEED], program))?;
            let mut d = vec![149, 39, 222, 155, 211, 124, 152, 26];
            d.extend(amount.to_le_bytes());
            d.extend(min_out.to_le_bytes());
            d.extend(0u64.to_le_bytes());
            (LAUNCHLAB, vec![0, 4, 5, 6, 7, 8, 16, 17], d)
        }
        1 => {
            require(a.len() == 14, Error::InvalidRoute)?;
            key(&a[0], *launch.key)?;
            key(&a[1], pda(&[b"vault_and_lp_mint_auth_seed"], &CPMM))?;
            key(&a[2], cfg.cp_config)?;
            let (m0, m1) = if state.base < state.quote {
                (state.base, state.quote)
            } else {
                (state.quote, state.base)
            };
            let pool = pda(
                &[b"pool", cfg.cp_config.as_ref(), m0.as_ref(), m1.as_ref()],
                &CPMM,
            );
            key(&a[3], pool)?;
            require(
                *a[3].owner == CPMM && *a[2].owner == CPMM,
                Error::InvalidRoute,
            )?;
            key(&a[4], token::ata(&state.base, launch.key, &token::TOKEN22))?;
            key(
                &a[5],
                token::ata(&state.quote, launch.key, &state.quote_program),
            )?;
            key(
                &a[6],
                pda(&[b"pool_vault", pool.as_ref(), state.base.as_ref()], &CPMM),
            )?;
            key(
                &a[7],
                pda(&[b"pool_vault", pool.as_ref(), state.quote.as_ref()], &CPMM),
            )?;
            key(&a[8], token::TOKEN22)?;
            key(&a[9], state.quote_program)?;
            key(&a[10], state.base)?;
            key(&a[11], state.quote)?;
            key(&a[12], pda(&[b"observation", pool.as_ref()], &CPMM))?;
            key(&a[13], CPMM)?;
            let mut d = vec![143, 190, 90, 218, 196, 30, 51, 222];
            d.extend(amount.to_le_bytes());
            d.extend(min_out.to_le_bytes());
            (CPMM, vec![3, 4, 5, 6, 7, 12], d)
        }
        _ => return Err(Error::InvalidRoute.into()),
    };
    let account_count = if route == 1 { 13 } else { 18 };
    require(
        a.iter().any(|x| *x.key == id && x.executable),
        Error::InvalidRoute,
    )?;
    let keys = a[..account_count]
        .iter()
        .enumerate()
        .map(|(i, x)| {
            if writable.contains(&i) {
                AccountMeta::new(*x.key, i == 0)
            } else {
                AccountMeta::new_readonly(*x.key, i == 0)
            }
        })
        .collect();
    let bump = Pubkey::find_program_address(&[LAUNCH_SEED, state.base.as_ref()], program).1;
    invoke_signed(
        &Instruction {
            program_id: id,
            accounts: keys,
            data,
        },
        a,
        &[&[LAUNCH_SEED, state.base.as_ref(), &[bump]]],
    )
}
