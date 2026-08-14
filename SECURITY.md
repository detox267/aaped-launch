# Security Policy

## Reporting a vulnerability

Please report suspected Moonz security vulnerabilities privately.

Do **not** open a public GitHub issue containing an undisclosed
vulnerability, exploit or proof of concept that could place users or
funds at risk.

Preferred confidential reporting route:

https://github.com/detox267/aaped-launch/security/advisories/new

## Program in scope

Moonz Launchpad mainnet program:

`DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk`

Exact source revision:

`mainnet-v2`

Final executable SHA256:

`ff4c3cae6e4e0f2bab9ffd6d30289e5f7804f89925b0266bc957dd249f9a560c`

The program's Solana loader upgrade authority is permanently
`None`.

## Relevant security reports

Security-relevant areas include, but are not limited to:

- instruction authorization
- signer and account validation
- PDA validation
- vault ownership and token handling
- bonding-curve trading
- buy and sell accounting
- fee accounting
- AMM operations
- pool-switch execution
- slippage enforcement
- CPI validation
- account substitution
- privilege escalation
- unauthorized fund movement
- denial-of-service conditions affecting user funds
- frontend or API transaction construction that could cause unsafe
  interaction with the mainnet program

## What to include

Where possible, provide:

1. A clear description of the issue.
2. The affected instruction or workflow.
3. Preconditions.
4. Reproduction steps.
5. A minimal proof of concept where appropriate.
6. Expected and observed behaviour.
7. Potential impact.
8. Relevant public Solana account addresses or transaction signatures.
9. Suggested mitigation, if known.

Never send wallet seed phrases, private keys or unrelated credentials.

## Immutable-program response

The Moonz on-chain program cannot be upgraded.

If a valid vulnerability is discovered, mitigation may therefore
involve operational protections, frontend/API changes, integration
changes, warnings, coordinated disclosure or migration planning,
depending on the issue.

## Coordinated disclosure

Please allow reasonable time for investigation and mitigation before
publishing details that could put users or funds at risk.

## Bug bounty

No financial reward or bug bounty is promised by this policy unless a
separate written Moonz bounty program explicitly states otherwise.

## Public information

Project:

https://moonz.fun

Source:

https://github.com/detox267/aaped-launch

Program ID:

`DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk`
