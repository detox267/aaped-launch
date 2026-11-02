use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo, hash::hashv, program_error::ProgramError, pubkey::Pubkey,
};

pub const VERSION: u8 = 1;
pub const CONFIG_SEED: &[u8] = b"config";
pub const AUTH_SEED: &[u8] = b"tax-authority";
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const MAX_LEAVES: u32 = 1024;
pub fn on_curve(key: &Pubkey) -> bool {
    key != &Pubkey::default()
        && solana_curve25519::edwards::validate_edwards(
            &solana_curve25519::edwards::PodEdwardsPoint(key.to_bytes()),
        )
}
pub const CONFIG_LEN: usize = 1 + 32 * 6 + 8 + 1;
pub const LAUNCH_LEN: usize = 1 + 32 * 5 + 8 * 9 + 32 + 128;

#[derive(Debug, Clone, Copy)]
#[repr(u32)]
pub enum Error {
    InvalidAccount = 6000,
    Unauthorized,
    InvalidState,
    Arithmetic,
    InvalidAmount,
    Paused,
    InvalidMint,
    InvalidPlatform,
    InvalidRoute,
    Slippage,
    InsufficientBudget,
    RoundActive,
    InvalidProof,
    AlreadyPaid,
    Expired,
    InvalidAuthority,
    UnsupportedQuote,
}
impl From<Error> for ProgramError {
    fn from(e: Error) -> Self {
        Self::Custom(e as u32)
    }
}
pub type Result<T> = std::result::Result<T, ProgramError>;
pub fn require(ok: bool, error: Error) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error.into())
    }
}
pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(Error::Arithmetic.into())
}
pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or(Error::InsufficientBudget.into())
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct Config {
    pub version: u8,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub operator: Pubkey,
    pub fee_wallet: Pubkey,
    pub platform: Pubkey,
    pub cp_config: Pubkey,
    pub max_swap_raw: u64,
    pub paused: bool,
}
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct Launch {
    pub version: u8,
    pub base: Pubkey,
    pub quote: Pubkey,
    pub quote_program: Pubkey,
    pub creator: Pubkey,
    pub pool: Pubkey,
    pub holder_available: u64,
    pub platform_available: u64,
    pub credited: u64,
    pub paid_holders: u64,
    pub paid_platform: u64,
    pub round: u64,
    pub remaining: u64,
    pub deadline: u64,
    pub leaves: u64,
    pub root: [u8; 32],
    pub bitmap: [u8; 128],
}
impl Launch {
    pub fn obligations(&self) -> Result<u64> {
        add(
            add(self.holder_available, self.platform_available)?,
            self.remaining,
        )
    }
    pub fn credit(&mut self, amount: u64) -> Result<()> {
        require(amount > 0, Error::InvalidAmount)?;
        // Cumulative rounding: splitting many small collections cannot avoid the platform share.
        let total = add(self.credited, amount)?;
        let fee = total / 4 - self.credited / 4;
        self.platform_available = add(self.platform_available, fee)?;
        self.holder_available = add(self.holder_available, amount - fee)?;
        self.credited = total;
        Ok(())
    }
    pub fn open_round(
        &mut self,
        root: [u8; 32],
        total: u64,
        leaves: u32,
        deadline: u64,
        now: u64,
    ) -> Result<()> {
        require(self.deadline == 0, Error::RoundActive)?;
        require(
            total > 0 && leaves > 0 && leaves <= MAX_LEAVES && root != [0; 32],
            Error::InvalidAmount,
        )?;
        require(
            deadline >= add(now, 3600)? && deadline <= add(now, 30 * 86400)?,
            Error::Expired,
        )?;
        self.holder_available = sub(self.holder_available, total)?;
        self.round = add(self.round, 1)?;
        self.root = root;
        self.remaining = total;
        self.leaves = leaves.into();
        self.deadline = deadline;
        self.bitmap = [0; 128];
        Ok(())
    }
    pub fn mark_paid(&mut self, index: u32, amount: u64, now: u64) -> Result<()> {
        require(self.deadline != 0 && now < self.deadline, Error::Expired)?;
        require(
            u64::from(index) < self.leaves && amount > 0,
            Error::InvalidAmount,
        )?;
        let byte = index as usize / 8;
        let bit = 1 << (index % 8);
        require(self.bitmap[byte] & bit == 0, Error::AlreadyPaid)?;
        self.remaining = sub(self.remaining, amount)?;
        self.paid_holders = add(self.paid_holders, amount)?;
        self.bitmap[byte] |= bit;
        Ok(())
    }
    pub fn close_round(&mut self, now: u64) -> Result<()> {
        require(
            self.deadline != 0 && (self.remaining == 0 || now >= self.deadline),
            Error::RoundActive,
        )?;
        self.holder_available = add(self.holder_available, self.remaining)?;
        self.remaining = 0;
        self.deadline = 0;
        self.root = [0; 32];
        self.leaves = 0;
        Ok(())
    }
}

// Stable Borsh ABI; variants are append-only. No arbitrary CPI or arbitrary withdrawal instruction.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum FusionInstruction {
    Initialize {
        operator: Pubkey,
        fee_wallet: Pubkey,
        platform: Pubkey,
        cp_config: Pubkey,
        max_swap_raw: u64,
    },
    SetControls {
        operator: Pubkey,
        max_swap_raw: u64,
        paused: bool,
    },
    ProposeAdmin {
        admin: Pubkey,
    },
    AcceptAdmin,
    Launch {
        raydium_data: Vec<u8>,
    },
    Collect,
    Convert {
        route: u8,
        amount: u64,
        min_out: u64,
        deadline: u64,
    },
    OpenRound {
        root: [u8; 32],
        total: u64,
        leaves: u32,
        deadline: u64,
    },
    Pay {
        round: u64,
        index: u32,
        amount: u64,
        proof: Vec<[u8; 32]>,
    },
    CloseRound,
    PayPlatform {
        amount: u64,
    },
    CreditDonation,
}

pub fn read<T: BorshDeserialize>(account: &AccountInfo, owner: &Pubkey, len: usize) -> Result<T> {
    require(
        account.owner == owner && account.data_len() == len,
        Error::InvalidAccount,
    )?;
    T::try_from_slice(&account.try_borrow_data()?).map_err(|_| Error::InvalidState.into())
}
pub fn write<T: BorshSerialize>(account: &AccountInfo, state: &T) -> Result<()> {
    require(account.is_writable, Error::InvalidAccount)?;
    let bytes = borsh::to_vec(state).map_err(|_| ProgramError::InvalidAccountData)?;
    require(bytes.len() == account.data_len(), Error::InvalidState)?;
    account.try_borrow_mut_data()?.copy_from_slice(&bytes);
    Ok(())
}
pub fn leaf(
    program: &Pubkey,
    launch: &Pubkey,
    round: u64,
    index: u32,
    wallet: &Pubkey,
    amount: u64,
) -> [u8; 32] {
    hashv(&[
        b"MOONZ_FUSION_HOLDER_V1",
        program.as_ref(),
        launch.as_ref(),
        &round.to_le_bytes(),
        &index.to_le_bytes(),
        wallet.as_ref(),
        &amount.to_le_bytes(),
    ])
    .to_bytes()
}
pub fn verify_proof(mut node: [u8; 32], proof: &[[u8; 32]], root: [u8; 32]) -> Result<()> {
    require(proof.len() <= 10, Error::InvalidProof)?;
    for sibling in proof {
        node = if node <= *sibling {
            hashv(&[b"MOONZ_FUSION_NODE_V1", &node, sibling])
        } else {
            hashv(&[b"MOONZ_FUSION_NODE_V1", sibling, &node])
        }
        .to_bytes();
    }
    require(node == root, Error::InvalidProof)
}
