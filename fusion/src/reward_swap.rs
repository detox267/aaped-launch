use crate::{rewards::MOONZ, state::*, token};
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey::{pubkey, Pubkey},
};
pub const OG: Pubkey = pubkey!("DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk");
pub const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OG_FEES: Pubkey = pubkey!("3mTCqBzGWMkUHqp3Ysepj3oewaMw6ndGQ368gEnxv1uH");
const JUPITER: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ROUTE: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];
const SHARED: [u8; 8] = [193, 32, 155, 51, 65, 214, 156, 129];
fn pda(seed: &[u8], key: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[seed, key.as_ref()], &OG).0
}
// Rebuild the immutable OG program's buy ABI; never accept caller-supplied OG instruction bytes.
pub fn buy(a: &[AccountInfo], amount: u64, min_out: u64, seeds: &[&[u8]]) -> Result<()> {
    require(
        a.len() >= 23
            && *a[15].key == OG
            && a[15].executable
            && *a[16].owner == OG
            && *a[16].key == pda(b"launch_state", &MOONZ),
        Error::InvalidRoute,
    )?;
    let d = a[16].try_borrow_data()?;
    require(
        d.len() == 386 && d[15..47] == MOONZ.to_bytes() && (d[10] == 1 || d[10] == 2),
        Error::InvalidState,
    )?;
    let creator = Pubkey::new_from_array(d[47..79].try_into().map_err(|_| Error::InvalidAccount)?);
    let quote = if d[10] == 1 || d[303] == 0 {
        token::WSOL
    } else {
        require(d[303] == 1, Error::InvalidRoute)?;
        USDC
    };
    drop(d);
    require(
        *a[9].key == quote
            && *a[17].key == pda(b"sale_vault", &MOONZ)
            && *a[18].key == pda(b"lp_vault", &MOONZ)
            && *a[19].key
                == pda(
                    if quote == token::WSOL {
                        b"treasury_wsol"
                    } else {
                        b"treasury_usdc"
                    },
                    &MOONZ,
                )
            && *a[20].key == pda(b"creator_fees", &creator)
            && *a[21].key == token::ata(&quote, a[20].key, &token::TOKEN)
            && *a[22].key == token::ata(&quote, &OG_FEES, &token::TOKEN),
        Error::InvalidRoute,
    )?;
    let order: &[usize] = if quote == token::WSOL {
        &[3, 16, 17, 18, 7, 10, 19, 20, 21, 22, 12]
    } else {
        &[3, 16, 18, 7, 10, 19, 20, 21, 22, 12]
    };
    let accounts = order
        .iter()
        .map(|i| {
            if *i == 20 || *i == 12 {
                AccountMeta::new_readonly(*a[*i].key, false)
            } else {
                AccountMeta::new(*a[*i].key, *i == 3)
            }
        })
        .collect();
    let mut data = if quote == token::WSOL {
        vec![102, 6, 61, 18, 1, 218, 235, 234]
    } else {
        vec![83, 76, 243, 144, 63, 114, 67, 204]
    };
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    let mut infos: Vec<_> = order.iter().map(|i| a[*i].clone()).collect();
    infos.push(a[15].clone());
    let lamports = a[3].lamports();
    invoke_signed(
        &Instruction {
            program_id: OG,
            accounts,
            data,
        },
        &infos,
        &[seeds],
    )?;
    require(a[3].lamports() == lamports, Error::InvalidAmount)
}
// Optional paired-asset -> current OG quote bridge. ExactIn Jupiter v6 only, with a separate,
// per-launch escrow signer. The launch PDA is NEVER a signer in this external CPI.
pub fn bridge(
    program: &Pubkey,
    a: &[AccountInfo],
    data: &[u8],
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    require(
        a.len() >= 24
            && a.len() <= 88
            && *a[23].key == JUPITER
            && a[23].executable
            && data.len() >= 31
            && data.len() <= 900,
        Error::InvalidRoute,
    )?;
    let r = &a[24..];
    let (authority, source, destination, destination_mint) = if data[..8] == ROUTE {
        require(r.len() >= 9, Error::InvalidRoute)?;
        (1, 2, 3, 5)
    } else if data[..8] == SHARED {
        require(r.len() >= 13 && *r[7].key == *a[4].key, Error::InvalidRoute)?;
        (2, 3, 6, 8)
    } else {
        return Err(Error::InvalidRoute.into());
    };
    require(
        *r[0].key == token::TOKEN
            && r[authority].key == a[3].key
            && r[source].key == a[8].key
            && r[destination].key == a[10].key
            && r[destination_mint].key == a[9].key,
        Error::InvalidRoute,
    )?;
    let footer = &data[data.len() - 19..];
    require(
        footer[..8] == amount.to_le_bytes()
            && footer[18] == 0
            && u16::from_le_bytes([footer[16], footer[17]]) <= 10_000,
        Error::InvalidRoute,
    )?;
    let mut counts = [0; 3];
    let mut metas = Vec::with_capacity(r.len());
    for info in r {
        let key = info.key;
        for (i, selected) in [a[3].key, a[8].key, a[10].key].iter().enumerate() {
            if key == *selected {
                counts[i] += 1;
            }
        }
        require(!info.is_signer, Error::Unauthorized)?;
        require(
            key != a[2].key && key != a[5].key && key != a[7].key,
            Error::InvalidRoute,
        )?;
        require(
            info.owner != program || key == a[3].key,
            Error::InvalidRoute,
        )?;
        if *info.owner == token::TOKEN || *info.owner == token::TOKEN22 {
            let d = info.try_borrow_data()?;
            // SPL Token accounts are 165+ bytes; mints are validated separately before the bridge.
            if d.len() >= 165 && d[32..64] == a[3].key.to_bytes() {
                require(key == a[8].key || key == a[10].key, Error::InvalidRoute)?;
            }
        }
        if key == &JUPITER {
            require(!info.is_writable, Error::InvalidRoute)?;
        }
        if key == a[8].key || key == a[10].key {
            require(info.is_writable, Error::InvalidRoute)?;
        }
        metas.push(if key == a[3].key {
            AccountMeta::new_readonly(*key, true)
        } else if info.is_writable {
            AccountMeta::new(*key, false)
        } else {
            AccountMeta::new_readonly(*key, false)
        });
    }
    require(counts == [1, 1, 1], Error::InvalidRoute)?;
    let mut infos = r.to_vec();
    infos.push(a[23].clone());
    let lamports = a[3].lamports();
    invoke_signed(
        &Instruction {
            program_id: JUPITER,
            accounts: metas,
            data: data.to_vec(),
        },
        &infos,
        &[seeds],
    )?;
    require(a[3].lamports() == lamports, Error::InvalidAmount)
}
