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

## Verified findings (baked into `lib/`)
- `LoanBrokerSet` requires `Account == Vault.Owner` (else `tecNO_PERMISSION`).
- LoanSet counterparty signing needs the `CPT` (`CounterpartyTxSign`) hash prefix, which this
  build verifies against. `xrpl@5.2.0-beta.1`'s `signLoanSetByCounterparty` produces it
  (`5.1.0` used the wrong `STX` prefix and was rejected).
- Interest is **cash-basis** (`LendingProtocolV1_1`): recognized on `LoanPay`, not at origination.
- Loan payment fields are already in the asset base unit (drops) with a fraction; round **up** to
  the next integer.
- `VaultWithdraw` with the **share MPT** amount redeems all shares (full value); a bare asset
  amount withdraws assets and leaves yield behind.
- Default recovery (verified): `DefaultCovered = min(DebtTotal * CoverRateMinimum *
  CoverRateLiquidation, DefaultAmount, CoverAvailable)`; cover moves to the vault and the residual
  is a realized `AssetsTotal` loss. After default, `CoverAvailable`/`DebtTotal` may read absent
  (XRPL omits zero-valued fields) — treat missing as `0`.
- Guardrail codes (verified): liquidity/cover `tecINSUFFICIENT_FUNDS`; caps `tecLIMIT_EXCEEDED`;
  late-without-flag `tecEXPIRED`; real underpayment `tecINSUFFICIENT_PAYMENT` (a sub-drop
  truncation alone is accepted). Impair/default timing violations → `tecTOO_SOON`.
