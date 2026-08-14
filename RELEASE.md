# Moonz Immutable Mainnet Release

## Mainnet deployment

Program ID:

`DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk`

ProgramData:

`G7YdufAaqGpQLUiTP4Copmn5TAALNxdSnktp78Lc86S5`

Final deployment slot:

`439004214`

Upgrade authority:

`None`

## Source

Original frozen development-repository commit:

`91b5e18452e44d9889493cb788f3eae2536c9884`

Original frozen Git tree:

`05db6d11abc2c8123998d3adfbc8e07057784588`

Public source-only commit:

`491e321c1f4f7b305a92d7dbc049363cbc997e76`

Public immutable source revision:

`mainnet-v2`

The `mainnet-v2` Git tree is exactly:

`05db6d11abc2c8123998d3adfbc8e07057784588`

## Executable provenance

Final executable SHA256:

`ff4c3cae6e4e0f2bab9ffd6d30289e5f7804f89925b0266bc957dd249f9a560c`

Final IDL SHA256:

`06e8d2ce708fde49702f4f2f2cde74f362de20f96840278fe67992c1f2e84183`

Full final ProgramData dump SHA256:

`60b27d7c2896e6c52064914190652196713c2d083f8f83608df173161d1c45ee`

## Account compatibility

The final release retained:

`LaunchState::LEN = 386`

`LaunchEscrow::LEN = 149`

Existing Moonz mainnet LaunchState accounts were compatibility-tested
against the exact final executable before deployment and remained
decodable following deployment.

## Immutability

Following final deployment and verification, the Solana loader upgrade
authority was permanently removed.

The program cannot be upgraded in place.

## Public-source licence

The Moonz source published in this repository, including the source
represented by `mainnet-v2`, is released under Apache License 2.0.

See [LICENSE](LICENSE).
