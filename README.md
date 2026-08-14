# Moonz Launchpad

Moonz Launchpad is an immutable Solana mainnet token launch program.

This repository is the public source, security-policy and release
provenance repository referenced by the deployed program.

## Mainnet program

**Program ID**

`DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk`

**ProgramData**

`G7YdufAaqGpQLUiTP4Copmn5TAALNxdSnktp78Lc86S5`

**Final deployment slot**

`439004214`

**Upgrade authority**

`None`

The on-chain Moonz program is permanently immutable.

## Exact deployed source

The immutable executable contains:

```text
source_code: https://github.com/detox267/aaped-launch
source_revision: mainnet-v2
```

The permanent `mainnet-v2` tag in this repository identifies a
source-only commit whose Git tree exactly matches the frozen release
source tree.

Original frozen release commit:

`91b5e18452e44d9889493cb788f3eae2536c9884`

Public source-only commit:

`491e321c1f4f7b305a92d7dbc049363cbc997e76`

Exact frozen Git tree:

`05db6d11abc2c8123998d3adfbc8e07057784588`

The Git commit IDs differ because this is a clean public publication
repository without the private development repository history.

The Git **tree** is identical.

## Final release hashes

Final executable SHA256:

`ff4c3cae6e4e0f2bab9ffd6d30289e5f7804f89925b0266bc957dd249f9a560c`

Final IDL SHA256:

`06e8d2ce708fde49702f4f2f2cde74f362de20f96840278fe67992c1f2e84183`

Final ProgramData dump SHA256:

`60b27d7c2896e6c52064914190652196713c2d083f8f83608df173161d1c45ee`

## Open source

The Moonz source code published in this repository, including the
source represented by the `mainnet-v2` tag, is made available under
the **Apache License 2.0**.

See [LICENSE](LICENSE).

## Security

Do not disclose suspected security vulnerabilities through a public
GitHub issue.

The preferred confidential reporting route is:

https://github.com/detox267/aaped-launch/security/advisories/new

See [SECURITY.md](SECURITY.md).

## Embedded security.txt

The immutable executable contains a Solana Security.txt V1 record with:

- project name: Moonz Launchpad
- project URL: https://moonz.fun
- security contact: GitHub security advisory reporting
- source repository: this repository
- source revision: `mainnet-v2`

The frozen record does not contain the required `policy` field.
Because the Solana loader upgrade authority is permanently `None`,
the embedded executable cannot be modified to add that field.

The current disclosure policy is maintained in
[SECURITY.md](SECURITY.md).

## Project

https://moonz.fun
