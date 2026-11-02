use moonz_fusion::state::*;
use solana_program::pubkey::Pubkey;
fn state() -> Launch {
    Launch {
        version: 1,
        base: Pubkey::new_unique(),
        quote: Pubkey::new_unique(),
        quote_program: Pubkey::new_unique(),
        creator: Pubkey::new_unique(),
        pool: Pubkey::new_unique(),
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
    }
}
#[test]
fn split_is_once_and_cannot_be_avoided_by_tiny_collections() {
    let mut s = state();
    for _ in 0..10_003 {
        s.credit(1).unwrap();
    }
    assert_eq!(s.platform_available, 2500);
    assert_eq!(s.holder_available, 7503);
    assert_eq!(s.obligations().unwrap(), 10003);
    let mut one = state();
    one.credit(10003).unwrap();
    assert_eq!(one.holder_available, s.holder_available);
}
#[test]
fn expiry_rolls_only_unpaid_net_holder_funds() {
    let mut s = state();
    s.credit(1000).unwrap();
    s.open_round([9; 32], 750, 3, 4600, 1000).unwrap();
    s.mark_paid(0, 100, 2000).unwrap();
    assert!(s.close_round(2000).is_err());
    s.close_round(4600).unwrap();
    assert_eq!(s.holder_available, 650);
    assert_eq!(s.platform_available, 250);
    assert_eq!(s.paid_holders, 100);
    assert_eq!(s.credited, 1000);
    assert_eq!(s.obligations().unwrap(), 900);
}
#[test]
fn replay_overpay_expired_claims_and_invalid_indexes_rejected() {
    let mut s = state();
    s.credit(1000).unwrap();
    s.open_round([9; 32], 750, 2, 4600, 1000).unwrap();
    assert!(s.mark_paid(2, 1, 2000).is_err());
    assert!(s.mark_paid(0, 751, 2000).is_err());
    s.mark_paid(0, 100, 2000).unwrap();
    assert!(s.mark_paid(0, 100, 2000).is_err());
    assert!(s.mark_paid(1, 100, 4600).is_err());
}
#[test]
fn budgets_and_deadlines_are_bounded() {
    let mut s = state();
    s.credit(1000).unwrap();
    assert!(s.open_round([1; 32], 751, 1, 4600, 1000).is_err());
    assert!(s.open_round([1; 32], 1, 1025, 4600, 1000).is_err());
    assert!(s.open_round([1; 32], 1, 1, 1001, 1000).is_err());
    s.open_round([1; 32], 750, 1, 4600, 1000).unwrap();
    assert!(s.open_round([2; 32], 1, 1, 4600, 1000).is_err());
}
#[test]
fn integer_boundaries_fail_closed() {
    let mut s = state();
    s.credit(u64::MAX).unwrap();
    assert_eq!(s.obligations().unwrap(), u64::MAX);
    assert!(s.credit(1).is_err());
    assert!(s.credit(0).is_err());
    assert!(add(u64::MAX, 1).is_err());
    assert!(sub(0, 1).is_err());
}
#[test]
fn account_sizes_match_wire_format() {
    assert_eq!(borsh::to_vec(&state()).unwrap().len(), LAUNCH_LEN);
    let k = Pubkey::new_unique();
    let c = Config {
        version: 1,
        admin: k,
        pending_admin: k,
        operator: k,
        fee_wallet: k,
        platform: k,
        cp_config: k,
        max_swap_raw: 1,
        paused: true,
    };
    assert_eq!(borsh::to_vec(&c).unwrap().len(), CONFIG_LEN);
}
#[test]
fn proofs_bind_ca_and_epoch() {
    let program = Pubkey::new_unique();
    let launch = Pubkey::new_unique();
    let wallet = Pubkey::new_unique();
    let root = leaf(&program, &launch, 1, 0, &wallet, 123);
    verify_proof(root, &[], root).unwrap();
    assert!(verify_proof(
        leaf(&program, &Pubkey::new_unique(), 1, 0, &wallet, 123),
        &[],
        root
    )
    .is_err());
    assert!(verify_proof(leaf(&program, &launch, 2, 0, &wallet, 123), &[], root).is_err());
}
