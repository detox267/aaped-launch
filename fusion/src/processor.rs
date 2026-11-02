use crate::{raydium, state::*, token};
use borsh::BorshDeserialize;
use solana_program::{
    account_info::AccountInfo, bpf_loader_upgradeable, clock::Clock, program::invoke_signed,
    program_error::ProgramError, pubkey::Pubkey, sysvar::Sysvar,
};

fn config(program: &Pubkey, a: &AccountInfo) -> Result<Config> {
    require(
        *a.key == Pubkey::find_program_address(&[CONFIG_SEED], program).0,
        Error::InvalidAccount,
    )?;
    let cfg: Config = read(a, program, CONFIG_LEN)?;
    require(cfg.version == VERSION, Error::InvalidState)?;
    Ok(cfg)
}
fn launch(program: &Pubkey, a: &AccountInfo) -> Result<Launch> {
    let s: Launch = read(a, program, LAUNCH_LEN)?;
    require(
        s.version == VERSION
            && *a.key == Pubkey::find_program_address(&[LAUNCH_SEED, s.base.as_ref()], program).0,
        Error::InvalidAccount,
    )?;
    Ok(s)
}
fn signer(a: &AccountInfo, key: &Pubkey) -> Result<()> {
    require(a.is_signer && a.key == key, Error::Unauthorized)
}
fn now() -> Result<u64> {
    Clock::get()?
        .unix_timestamp
        .try_into()
        .map_err(|_| Error::Expired.into())
}
fn operator(a: &AccountInfo, cfg: &Config) -> Result<()> {
    signer(a, &cfg.operator)?;
    require(!cfg.paused, Error::Paused)
}
fn count(a: &[AccountInfo], n: usize) -> Result<()> {
    require(a.len() == n, Error::InvalidAccount)
}

pub fn process_instruction(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> Result<()> {
    // Bound untrusted Vec lengths before Borsh parsing.
    require(data.len() <= 1024, Error::InvalidAmount)?;
    let ix = FusionInstruction::try_from_slice(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        FusionInstruction::Initialize {
            operator,
            fee_wallet,
            platform,
            cp_config,
            max_swap_raw,
        } => {
            count(a, 4)?;
            require(
                a[0].is_signer
                    && on_curve(&operator)
                    && on_curve(&fee_wallet)
                    && max_swap_raw > 0
                    && platform != Pubkey::default()
                    && cp_config != Pubkey::default(),
                Error::InvalidAuthority,
            )?;
            // Only the actual loader-v3 upgrade authority can bootstrap. Never consume or revoke that authority.
            let (pd, _) =
                Pubkey::find_program_address(&[program.as_ref()], &bpf_loader_upgradeable::ID);
            require(
                *a[2].key == pd && *a[2].owner == bpf_loader_upgradeable::ID,
                Error::InvalidAuthority,
            )?;
            let d = a[2].try_borrow_data()?;
            require(
                d.len() >= 45
                    && d[..4] == 3u32.to_le_bytes()
                    && d[12] == 1
                    && d[13..45] == a[0].key.to_bytes(),
                Error::InvalidAuthority,
            )?;
            drop(d);
            let (key, bump) = Pubkey::find_program_address(&[CONFIG_SEED], program);
            require(*a[1].key == key, Error::InvalidAccount)?;
            token::create_pda(
                &a[0],
                &a[1],
                &a[3],
                program,
                CONFIG_LEN,
                &[CONFIG_SEED, &[bump]],
            )?;
            write(
                &a[1],
                &Config {
                    version: VERSION,
                    admin: *a[0].key,
                    pending_admin: Pubkey::default(),
                    operator,
                    fee_wallet,
                    platform,
                    cp_config,
                    max_swap_raw,
                    paused: true,
                },
            )
        }
        FusionInstruction::SetControls {
            operator: op,
            max_swap_raw,
            paused,
        } => {
            count(a, 2)?;
            let mut cfg = config(program, &a[1])?;
            signer(&a[0], &cfg.admin)?;
            require(on_curve(&op) && max_swap_raw > 0, Error::InvalidAuthority)?;
            cfg.operator = op;
            cfg.max_swap_raw = max_swap_raw;
            cfg.paused = paused;
            write(&a[1], &cfg)
        }
        FusionInstruction::ProposeAdmin { admin } => {
            count(a, 2)?;
            let mut cfg = config(program, &a[1])?;
            signer(&a[0], &cfg.admin)?;
            require(
                on_curve(&admin) && admin != cfg.admin,
                Error::InvalidAuthority,
            )?;
            cfg.pending_admin = admin;
            write(&a[1], &cfg)
        }
        FusionInstruction::AcceptAdmin => {
            count(a, 2)?;
            let mut cfg = config(program, &a[1])?;
            signer(&a[0], &cfg.pending_admin)?;
            cfg.admin = cfg.pending_admin;
            cfg.pending_admin = Pubkey::default();
            write(&a[1], &cfg)
        }
        FusionInstruction::Launch { raydium_data } => {
            require(a.len() >= 22 && a.len() <= 24, Error::InvalidAccount)?;
            let cfg = config(program, &a[1])?;
            require(!cfg.paused, Error::Paused)?;
            let r = &a[7..];
            let base = r[6].key;
            let quote = r[7].key;
            require(base != quote, Error::InvalidMint)?;
            let (key, bump) = Pubkey::find_program_address(&[LAUNCH_SEED, base.as_ref()], program);
            require(
                *a[2].key == key
                    && *a[6].key == Pubkey::find_program_address(&[AUTH_SEED], program).0,
                Error::InvalidAccount,
            )?;
            token::create_pda(
                &a[0],
                &a[2],
                &r[12],
                program,
                LAUNCH_LEN,
                &[LAUNCH_SEED, base.as_ref(), &[bump]],
            )?;
            raydium::initialize(r, a[0].key, &cfg, a[6].key, raydium_data)?;
            token::create_ata(&a[0], &a[3], &a[2], &r[6], &r[12], &r[10], &a[5])?;
            token::create_ata(&a[0], &a[4], &a[2], &r[7], &r[12], &r[11], &a[5])?;
            // Pre-funded vault tokens are credited only by CreditDonation, never silently allocated twice.
            write(
                &a[2],
                &Launch {
                    version: VERSION,
                    base: *base,
                    quote: *quote,
                    quote_program: *r[11].key,
                    creator: *a[0].key,
                    pool: *r[5].key,
                    holder_available: 0,
                    platform_available: 0,
                    credited: 0,
                    paid_holders: 0,
                    paid_platform: 0,
                    round: 0,
                    remaining: 0,
                    deadline: 0,
                    leaves: 0,
                    root: [0; 32],
                    bitmap: [0; 128],
                },
            )
        }
        FusionInstruction::Collect => {
            require(a.len() >= 7 && a.len() <= 23, Error::InvalidAccount)?;
            let cfg = config(program, &a[1])?;
            operator(&a[0], &cfg)?;
            let s = launch(program, &a[2])?;
            require(
                *a[3].key == s.base && *a[6].key == token::TOKEN22,
                Error::InvalidMint,
            )?;
            let (tax, bump) = Pubkey::find_program_address(&[AUTH_SEED], program);
            require(*a[5].key == tax, Error::InvalidAuthority)?;
            token::base(&a[3], &tax)?;
            token::vault(&a[4], &s.base, a[2].key, &token::TOKEN22)?;
            for (i, source) in a[7..].iter().enumerate() {
                require(
                    *source.owner == token::TOKEN22 && source.is_writable,
                    Error::InvalidAccount,
                )?;
                let d = source.try_borrow_data()?;
                require(
                    d.len() >= 165 && d[..32] == s.base.to_bytes(),
                    Error::InvalidMint,
                )?;
                require(
                    !a[7..7 + i].iter().any(|x| x.key == source.key),
                    Error::InvalidAccount,
                )?;
            }
            let seeds: &[&[u8]] = &[AUTH_SEED, &[bump]];
            invoke_signed(&spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_mint(
                &token::TOKEN22,a[3].key,a[4].key,&tax,&[])?,&a[3..7],&[seeds])?;
            if a.len() > 7 {
                let sources: Vec<&Pubkey> = a[7..].iter().map(|x| x.key).collect();
                invoke_signed(&spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_accounts(
                    &token::TOKEN22,a[3].key,a[4].key,&tax,&[],&sources)?,&a[3..],&[seeds])?;
            }
            Ok(())
        }
        FusionInstruction::Convert {
            route,
            amount,
            min_out,
            deadline,
        } => {
            require(a.len() >= 7, Error::InvalidAccount)?;
            let cfg = config(program, &a[1])?;
            operator(&a[0], &cfg)?;
            let mut s = launch(program, &a[2])?;
            let timestamp = now()?;
            require(
                deadline >= timestamp && deadline <= add(timestamp, 300)?,
                Error::Expired,
            )?;
            require(
                amount > 0 && amount <= cfg.max_swap_raw && min_out > 0,
                Error::InvalidAmount,
            )?;
            require(
                *a[3].key == s.base && *a[4].key == s.quote && *a[4].owner == s.quote_program,
                Error::InvalidMint,
            )?;
            token::base(
                &a[3],
                &Pubkey::find_program_address(&[AUTH_SEED], program).0,
            )?;
            token::quote(&a[4])?;
            let base_before = token::vault(&a[5], &s.base, a[2].key, &token::TOKEN22)?;
            let quote_before = token::vault(&a[6], &s.quote, a[2].key, &s.quote_program)?;
            require(
                base_before >= amount && quote_before >= s.obligations()?,
                Error::InsufficientBudget,
            )?;
            raydium::convert(program, &a[2], &a[7..], &cfg, &s, route, amount, min_out)?;
            let base_after = token::vault(&a[5], &s.base, a[2].key, &token::TOKEN22)?;
            let quote_after = token::vault(&a[6], &s.quote, a[2].key, &s.quote_program)?;
            require(
                base_after == sub(base_before, amount)? && quote_after >= quote_before,
                Error::InvalidAmount,
            )?;
            let received = quote_after - quote_before;
            require(received >= min_out, Error::Slippage)?;
            s.credit(received)?;
            write(&a[2], &s)
        }
        FusionInstruction::OpenRound {
            root,
            total,
            leaves,
            deadline,
        } => {
            count(a, 3)?;
            let cfg = config(program, &a[1])?;
            operator(&a[0], &cfg)?;
            let mut s = launch(program, &a[2])?;
            s.open_round(root, total, leaves, deadline, now()?)?;
            write(&a[2], &s)
        }
        FusionInstruction::Pay {
            round,
            index,
            amount,
            proof,
        } => {
            count(a, 10)?;
            let cfg = config(program, &a[1])?;
            require(!cfg.paused, Error::Paused)?;
            let mut s = launch(program, &a[2])?;
            require(s.round == round, Error::InvalidProof)?;
            verify_proof(
                leaf(program, a[2].key, round, index, a[5].key, amount),
                &proof,
                s.root,
            )?;
            // Check and persist consumption before CPI; Solana rolls back both on failure.
            let obligations = s.obligations()?;
            s.mark_paid(index, amount, now()?)?;
            require(
                token::vault(&a[4], &s.quote, a[2].key, &s.quote_program)? >= obligations,
                Error::InsufficientBudget,
            )?;
            write(&a[2], &s)?;
            token::pay(program, a, &s, amount)
        }
        FusionInstruction::CloseRound => {
            count(a, 1)?;
            let mut s = launch(program, &a[0])?;
            s.close_round(now()?)?;
            write(&a[0], &s)
        }
        FusionInstruction::PayPlatform { amount } => {
            count(a, 10)?;
            let cfg = config(program, &a[1])?;
            require(!cfg.paused, Error::Paused)?;
            require(*a[5].key == cfg.fee_wallet, Error::Unauthorized)?;
            let mut s = launch(program, &a[2])?;
            let obligations = s.obligations()?;
            s.platform_available = sub(s.platform_available, amount)?;
            s.paid_platform = add(s.paid_platform, amount)?;
            require(
                token::vault(&a[4], &s.quote, a[2].key, &s.quote_program)? >= obligations,
                Error::InsufficientBudget,
            )?;
            write(&a[2], &s)?;
            token::pay(program, a, &s, amount)
        }
        FusionInstruction::CreditDonation => {
            count(a, 5)?;
            let cfg = config(program, &a[1])?;
            operator(&a[0], &cfg)?;
            let mut s = launch(program, &a[2])?;
            require(
                *a[3].key == s.quote && *a[3].owner == s.quote_program,
                Error::InvalidMint,
            )?;
            token::quote(&a[3])?;
            let balance = token::vault(&a[4], &s.quote, a[2].key, &s.quote_program)?;
            let extra = sub(balance, s.obligations()?)?;
            s.credit(extra)?;
            write(&a[2], &s)
        }
    }
}
