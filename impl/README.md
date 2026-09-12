# impl — runnable plan

Runnable implementation of the `plan/` phases against the XRPL Lending Hackathon devnet.

## Network (verified live 2026-09-12)
- WebSocket: `wss://lending-hackathon.dev.ripplex.io:51233` (build `3.4.0-rc1`, net `4001`)
- Faucet: `https://lending-hackathon-faucet.dev.ripplex.io/accounts` (POST `{}` → funds and
  returns a **new** account's `{ address, secret }`; ignores `destination`)
- Explorer: `https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/`
- Reserves: base 10 XRP, incremental 2 XRP

Override with env vars: `XRPL_WSS`, `XRPL_FAUCET`, `XRPL_EXPLORER`.

## Run
```sh
pnpm install --filter first-loss-credit-impl   # links xrpl@5.2.0-beta.1 from the store
node part-1/1.1_vault_lifecycle_and_yield.mjs
```

## Layout
- `lib/index.mjs` — generic XRPL primitives (connect, fundAccounts, submitAndWait,
  submitExpectingFailure, submitSignedExpectingFailure, roundUpToAssetUnit, waitUntilAfter,
  ledger reads, explorer, logFriction).
- `lib/lending.mjs` — phase-agnostic protocol builders (createVault, vaultDeposit, createBroker,
  depositCover, signedLoanSet, originateLoan) + metadata/run-log helpers. Phases compose these;
  no phase re-implements setup and no phase imports another phase.
- `lib/credentials.mjs` — phase-agnostic XLS-70/80 membership builders (createCredential,
  acceptCredential, issueAcceptedCredential, readCredential, isAccepted, setPermissionedDomain,
  acceptedCredential, readPermissionedDomain).
- `lib/mpt.mjs` — phase-agnostic XLS-33 MPT builders (createMptIssuance, authorizeMpt,
  readMptIssuance, readMptoken, mptBalance, isMptAuthorized) + flag enum re-export.
- `lib/escrow.mjs` — phase-agnostic XLS-85 TokenEscrow builders (makeCondition for a
  dependency-free PREIMAGE-SHA-256 condition/fulfillment, createEscrow capturing the create
  Sequence, escrowFinishTx, escrowCancelTx).
- `part-1/` — Part 1 (Vanilla), all verified live on-chain:
  - `1.1_vault_lifecycle_and_yield.mjs` — vault lifecycle + real yield.
  - `1.2_broker_and_first_loss_cover.mjs` — broker + first-loss cover minimum.
  - `1.3_loan_origination_and_repayment.mjs` — dual-signed LoanSet + repayment + tfLoanFullPayment rules.
  - `1.4_impairment_default_recovery.mjs` — impair, default, first-loss recovery, timing guards.
  - `1.5_guardrail_gallery.mjs` — 8 guardrail rejections (A-H), each with a positive control.
- `part-2/` — Part 2 (Permissioned Domains + Credentials), verified live on-chain:
  - `2.1_credential_issuance.mjs` — CredentialCreate + CredentialAccept; one instance per subject,
    keyed by (Issuer, Subject, CredentialType), lsfAccepted set only after accept.
  - `2.2_permissioned_domain.mjs` — PermissionedDomainSet with the wrapped
    `{ Credential: { Issuer, CredentialType } }` accepted list; standalone membership proof
    (member qualifies, outsider does not).
  - `2.3_gated_private_vault.mjs` — tfVaultPrivate vault bound to a domain; member deposit
    succeeds, outsider and unaccepted-credential holder rejected with tecNO_AUTH. Protocol
    gates depositors/share holders only, not borrowers.
- `part-3/` — Part 3 (MPTs), verified live on-chain:
  - `3.1_mpt_issuance.mjs` — MPTokenIssuanceCreate (CanTransfer + RequireAuth + CanEscrow);
    two-step auth (holder opt-in + issuer authorize); positive balance only after both steps.
  - `3.2_mpt_asset_vault.mjs` — Single Asset Vault over an MPT; Scale omitted (reads 0); MPT
    deposit/withdraw round-trip; explicit Scale on an MPT asset rejected client-side.
  - `3.3_mpt_loan_flow.mjs` — full loan (originate + repay) in an MPT vault; PrincipalRequested
    string vs LoanPay MPT-amount object; payment must round UP to a whole base unit.
- `part-4/` — Part 4 (TokenEscrow collateral), verified live on-chain:
  - `4.1_token_escrow_basics.mjs` — MPT escrow: lock, finish to destination (crypto-condition),
    cancel back to owner; early finish tecNO_PERMISSION, wrong fulfillment tecCRYPTOCONDITION_ERROR.
  - `4.2_app_verified_collateralized_origination.mjs` — collateral locked in escrow to the broker
    owner; application gate verifies the validated escrow before LoanSet; no on-chain escrow<->loan
    link (Loan object does not expose Data); mapping kept in application state.

## Verified findings (baked into `lib/`)
- `LoanBrokerSet` requires `Account == Vault.Owner` (else `tecNO_PERMISSION`).
- LoanSet counterparty signing needs the `CPT` (`CounterpartyTxSign`) hash prefix, which this
  build verifies against. `xrpl@5.2.0-beta.1`'s `signLoanSetByCounterparty` produces it
  (`5.1.0` used the wrong `STX` prefix and was rejected).
- Interest is **cash-basis** (`LendingProtocolV1_1`): recognized on `LoanPay`, not at origination.
- Loan payment fields are already in the asset base unit (drops) with a fraction; round **up** to
  the next integer. For an **MPT** vault the sub-unit shortfall is not tolerated: a truncated-down
  `LoanPay` fails `tecINSUFFICIENT_PAYMENT` (verified 3.3), unlike the XRP drops case below.
- `VaultWithdraw` with the **share MPT** amount redeems all shares (full value); a bare asset
  amount withdraws assets and leaves yield behind.
- MPToken balance model (verified 4.1): `MPTAmount` is the **spendable** balance; `LockedAmount`
  is the escrow-locked amount, still owned but not spendable. They are additive (total owned =
  `MPTAmount + LockedAmount`), so do **not** subtract `LockedAmount` from `MPTAmount`.
- Token escrow (verified 4.1): MPT escrow between non-issuers needs `tfMPTCanEscrow` +
  `tfMPTCanTransfer`. `EscrowFinish` before `FinishAfter` → `tecNO_PERMISSION`; a wrong
  `Fulfillment` → `tecCRYPTOCONDITION_ERROR`. `EscrowCreate` has no `Data` field.
- No escrow↔loan binding (verified 4.2): `LoanSet` does not verify any escrow; the `Loan` object
  does **not** expose a `Data` field even when `LoanSet.Data` is set, and neither object references
  the other. Collateral enforcement is application logic; keep the mapping in application state.
- Default recovery (verified): `DefaultCovered = min(DebtTotal * CoverRateMinimum *
  CoverRateLiquidation, DefaultAmount, CoverAvailable)`; cover moves to the vault and the residual
  is a realized `AssetsTotal` loss. After default, `CoverAvailable`/`DebtTotal` may read absent
  (XRPL omits zero-valued fields) — treat missing as `0`.
- Guardrail codes (verified): liquidity/cover `tecINSUFFICIENT_FUNDS`; caps `tecLIMIT_EXCEEDED`;
  late-without-flag `tecEXPIRED`; real underpayment `tecINSUFFICIENT_PAYMENT` (a sub-drop
  truncation alone is accepted). Impair/default timing violations → `tecTOO_SOON`.
