# Loaded primitives for a lending project

The event's "Loaded" flavour = Vanilla (XLS-65 + XLS-66) plus one more ledger primitive. Add one
only when it creates a real use case, not to tick a box. For a first-loss institutional-credit
project all four below are meaningful; each opens a distinct code surface to report friction on.

## 1. Permissioned Domains + Credentials (high fit)
Gate who may lend or borrow (KYC). Hooks in natively: `VaultCreate` takes `DomainID` plus the
`tfVaultPrivate` flag, so a private vault only admits credentialed accounts.
- Extra transactions: `PermissionedDomainSet`, `CredentialCreate`, `CredentialAccept`.
- Guardrail to show: an uncredentialed deposit/borrow → `tecNO_AUTH`.

## 2. MPTs (high fit — often required here)
RLUSD test tokens exist only on Testnet, not on the lending hackathon devnet, so you cannot use
real RLUSD as the vault asset on the lending network. Issue your own stablecoin as an MPT and make it the vault
`Asset`; model RLUSD in the narrative only.
- Extra transactions: `MPTokenIssuanceCreate`, `MPTokenAuthorize`.
- Gotcha to report: the vault forces `Scale = 0` for an MPT asset.

## 3. TokenEscrow (medium fit)
Borrower posts token collateral in escrow beside the broker's first-loss cover → a secured-credit
story. Exercises token-enabled `EscrowCreate` / `EscrowFinish` / `EscrowCancel` alongside
`LoanManage` default.

## 4. Sponsored fees / reserves (medium fit)
Broker or treasury sponsors the borrower's reserve and fees so the borrower needs no XRP float.
Exercises the sponsorship flow and its interaction with the per-loan owner reserve.

## Reporting angle
Each primitive is a fresh friction channel: credential auth errors, MPT scale quirks,
escrow-as-collateral coordination, sponsorship reserve interactions. The manual feedback report
should name the primitive, the transaction, the library version, and the exact code observed.
