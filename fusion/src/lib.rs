#![allow(deprecated)]
mod processor;
mod raydium;
pub mod state;
mod token;

pub use processor::process_instruction;
#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Moonz Fusion",
    project_url: "https://moonz.fun",
    contacts: "link:https://github.com/detox267/aaped-launch/security/advisories/new",
    policy: "https://github.com/detox267/aaped-launch/blob/codex/fusion-pda-v1/fusion/SECURITY.md",
    source_code: "https://github.com/detox267/aaped-launch/tree/codex/fusion-pda-v1/fusion",
    preferred_languages: "en"
}
