use crate::state::*;
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_option::COption,
    program_pack::Pack,
    pubkey::{pubkey, Pubkey},
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token_2022::{
    extension::{
        transfer_fee::TransferFeeConfig, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    state::{Account, AccountState, Mint},
};

pub const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN22: Pubkey = spl_token_2022::ID;
pub const ATA: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub fn token_program(key: &Pubkey) -> Result<()> {
    require(*key == TOKEN || *key == TOKEN22, Error::InvalidMint)
}
pub fn ata(mint: &Pubkey, owner: &Pubkey, program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), program.as_ref(), mint.as_ref()], &ATA).0
}
pub fn mint(account: &AccountInfo) -> Result<Mint> {
    token_program(account.owner)?;
    let data = account.try_borrow_data()?;
    let m = StateWithExtensions::<Mint>::unpack(&data)?;
    require(m.base.is_initialized, Error::InvalidMint)?;
    Ok(m.base)
}
pub fn quote(account: &AccountInfo) -> Result<Mint> {
    let m = mint(account)?;
    // Quote issuers such as USDC may retain freeze authority. Frozen accounts fail at transfer time.
    let data = account.try_borrow_data()?;
    for ext in StateWithExtensions::<Mint>::unpack(&data)?.get_extension_types()? {
        require(
            matches!(
                ext,
                ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
            ),
            Error::UnsupportedQuote,
        )?;
    }
    Ok(m)
}
pub fn base(account: &AccountInfo, tax_authority: &Pubkey) -> Result<Mint> {
    require(*account.owner == TOKEN22, Error::InvalidMint)?;
    let data = account.try_borrow_data()?;
    let m = StateWithExtensions::<Mint>::unpack(&data)?;
    require(
        m.base.is_initialized
            && m.base.decimals == 6
            && m.base.mint_authority == COption::None
            && m.base.freeze_authority == COption::None,
        Error::InvalidMint,
    )?;
    for ext in m.get_extension_types()? {
        require(
            matches!(
                ext,
                ExtensionType::TransferFeeConfig
                    | ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
            ),
            Error::InvalidMint,
        )?;
    }
    let fee = m.get_extension::<TransferFeeConfig>()?;
    require(
        Option::<Pubkey>::from(fee.withdraw_withheld_authority) == Some(*tax_authority),
        Error::InvalidAuthority,
    )?;
    require(
        u16::from(fee.older_transfer_fee.transfer_fee_basis_points) == 300
            && u16::from(fee.newer_transfer_fee.transfer_fee_basis_points) == 300
            && u64::from(fee.older_transfer_fee.maximum_fee) == u64::MAX
            && u64::from(fee.newer_transfer_fee.maximum_fee) == u64::MAX,
        Error::InvalidMint,
    )?;
    Ok(m.base)
}
pub fn account(
    info: &AccountInfo,
    mint: &Pubkey,
    owner: &Pubkey,
    program: &Pubkey,
) -> Result<Account> {
    require(info.owner == program, Error::InvalidAccount)?;
    let data = info.try_borrow_data()?;
    let a = StateWithExtensions::<Account>::unpack(&data)?.base;
    require(
        a.mint == *mint
            && a.owner == *owner
            && a.state == AccountState::Initialized
            && a.delegate == COption::None
            && a.close_authority == COption::None,
        Error::InvalidAccount,
    )?;
    Ok(a)
}
pub fn vault(info: &AccountInfo, mint: &Pubkey, owner: &Pubkey, program: &Pubkey) -> Result<u64> {
    require(
        *info.key == ata(mint, owner, program),
        Error::InvalidAccount,
    )?;
    Ok(account(info, mint, owner, program)?.amount)
}
pub fn create_ata<'a>(
    payer: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    program: &AccountInfo<'a>,
    associated: &AccountInfo<'a>,
) -> Result<()> {
    require(
        *associated.key == ATA && *program.key == *mint.owner && *system.key == system_program::ID,
        Error::InvalidAccount,
    )?;
    require(
        *destination.key == ata(mint.key, authority.key, program.key),
        Error::InvalidAccount,
    )?;
    invoke(
        &Instruction {
            program_id: ATA,
            accounts: vec![
                AccountMeta::new(*payer.key, true),
                AccountMeta::new(*destination.key, false),
                AccountMeta::new_readonly(*authority.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new_readonly(*system.key, false),
                AccountMeta::new_readonly(*program.key, false),
            ],
            data: vec![1],
        },
        &[
            payer.clone(),
            destination.clone(),
            authority.clone(),
            mint.clone(),
            system.clone(),
            program.clone(),
            associated.clone(),
        ],
    )
}
pub fn transfer<'a>(
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    program: &AccountInfo<'a>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    require(*program.key == *mint.owner, Error::InvalidMint)?;
    let decimals = self::mint(mint)?.decimals;
    invoke_signed(
        &spl_token_2022::instruction::transfer_checked(
            program.key,
            source.key,
            mint.key,
            destination.key,
            authority.key,
            &[],
            amount,
            decimals,
        )?,
        &[
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
            program.clone(),
        ],
        &[seeds],
    )
}
pub fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    owner: &Pubkey,
    size: usize,
    seeds: &[&[u8]],
) -> Result<()> {
    require(
        payer.is_signer
            && payer.is_writable
            && account.is_writable
            && *system.key == system_program::ID,
        Error::Unauthorized,
    )?;
    require(
        account.owner == &system_program::ID && account.data_is_empty(),
        Error::InvalidAccount,
    )?;
    let rent = Rent::get()?.minimum_balance(size).max(1);
    // Pre-funding a PDA cannot block initialization.
    if account.lamports() < rent {
        invoke(
            &system_instruction::transfer(payer.key, account.key, rent - account.lamports()),
            &[payer.clone(), account.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(account.key, size as u64),
        &[account.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, owner),
        &[account.clone(), system.clone()],
        &[seeds],
    )
}

// Payment accounts: payer, config, launch, quote mint, quote vault, recipient, recipient ATA,
// token program, system program, temporary WSOL PDA. For SOL the recipient ATA is unused.
pub fn pay<'a>(program: &Pubkey, a: &[AccountInfo<'a>], state: &Launch, amount: u64) -> Result<()> {
    require(a.len() == 10 && amount > 0, Error::InvalidAmount)?;
    let mint = &a[3];
    let source = &a[4];
    let to = &a[5];
    let dest = &a[6];
    let token = &a[7];
    require(
        *mint.key == state.quote
            && *token.key == state.quote_program
            && *mint.owner == state.quote_program,
        Error::InvalidMint,
    )?;
    quote(mint)?;
    let before = vault(source, mint.key, a[2].key, token.key)?;
    require(before >= state.obligations()?, Error::InsufficientBudget)?;
    require(on_curve(to.key), Error::InvalidAccount)?;
    let bump = Pubkey::find_program_address(&[LAUNCH_SEED, state.base.as_ref()], program).1;
    let seeds: &[&[u8]] = &[LAUNCH_SEED, state.base.as_ref(), &[bump]];
    if state.quote == WSOL {
        require(
            state.quote_program == TOKEN && *to.owner == system_program::ID && to.data_is_empty(),
            Error::InvalidAccount,
        )?;
        let temp = &a[9];
        let (key, bump) = Pubkey::find_program_address(&[b"unwrap", a[2].key.as_ref()], program);
        require(*temp.key == key, Error::InvalidAccount)?;
        create_pda(
            &a[0],
            temp,
            &a[8],
            &TOKEN,
            Account::LEN,
            &[b"unwrap", a[2].key.as_ref(), &[bump]],
        )?;
        let rent = temp.lamports();
        invoke(
            &spl_token_2022::instruction::initialize_account3(
                &TOKEN, temp.key, mint.key, a[2].key,
            )?,
            &[temp.clone(), mint.clone(), token.clone()],
        )?;
        transfer(source, mint, temp, &a[2], token, amount, seeds)?;
        invoke_signed(
            &spl_token_2022::instruction::close_account(&TOKEN, temp.key, a[2].key, a[2].key, &[])?,
            &[temp.clone(), a[2].clone(), token.clone()],
            &[seeds],
        )?;
        // Return temporary account funding (including unsolicited pre-funding); no vault funds subsidize gas.
        **a[2].try_borrow_mut_lamports()? = sub(a[2].lamports(), add(amount, rent)?)?;
        **to.try_borrow_mut_lamports()? = add(to.lamports(), amount)?;
        **a[0].try_borrow_mut_lamports()? = add(a[0].lamports(), rent)?;
    } else {
        require(
            *dest.key == ata(mint.key, to.key, token.key),
            Error::InvalidAccount,
        )?;
        let previous = account(dest, mint.key, to.key, token.key)?.amount;
        transfer(source, mint, dest, &a[2], token, amount, seeds)?;
        require(
            account(dest, mint.key, to.key, token.key)?.amount == add(previous, amount)?,
            Error::InvalidAmount,
        )?;
    }
    require(
        vault(source, mint.key, a[2].key, token.key)? == sub(before, amount)?,
        Error::InvalidAmount,
    )
}
