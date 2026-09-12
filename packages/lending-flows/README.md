# lending-flows

Runnable first-loss institutional credit flows against the XRPL lending devnet
(XLS-33/65/66/70/80/85). Each flow is self-contained: it funds its own accounts and
builds its own objects, imports no other flow, and is verified live on-chain.

## Network (verified live 2026-09-12)
- WebSocket: `wss://lending-hackathon.dev.ripplex.io:51233` (build `3.4.0-rc1`, net `4001`)
- Faucet: `https://lending-hackathon-faucet.dev.ripplex.io/accounts` (POST `{}` → funds and
  returns a **new** account's `{ address, secret }`; ignores `destination`)
- Explorer: `https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/`
- Reserves: base 10 XRP, incremental 2 XRP

Override with env vars: `XRPL_WSS`, `XRPL_FAUCET`, `XRPL_EXPLORER`.

## Run
```sh
pnpm install --filter lending-flows   # links xrpl@5.2.0-beta.1 from the store
node src/vault/lifecycle-and-yield.mjs
```
Or use the named scripts, e.g. `pnpm --filter lending-flows credentials:issuance`.

## Layout
Shared builders live in `src/lib/`; flows are grouped by the protocol area they exercise.

- `lib/index.mjs` — generic XRPL primitives (connect, fundAccounts, submitAndWait,
  submitExpectingFailure, submitSignedExpectingFailure, roundUpToAssetUnit, waitUntilAfter,
  ledger reads, explorer, logFriction).
- `lib/lending.mjs` — shared lending builders (createVault, vaultDeposit, createBroker,
  depositCover, signedLoanSet, originateLoan) + metadata/run-log helpers.
- `lib/credentials.mjs` — shared XLS-70/80 membership builders (createCredential,
  acceptCredential, issueAcceptedCredential, readCredential, isAccepted, setPermissionedDomain,
  acceptedCredential, readPermissionedDomain).
- `lib/mpt.mjs` — shared XLS-33 MPT builders (createMptIssuance, authorizeMpt, readMptIssuance,
  readMptoken, mptBalance, isMptAuthorized) + flag enum re-export.
- `lib/escrow.mjs` — shared XLS-85 TokenEscrow builders (makeCondition for a dependency-free
  PREIMAGE-SHA-256 condition/fulfillment, createEscrow capturing the create Sequence,
  escrowFinishTx, escrowCancelTx, readEscrow).

### Flows
- `vault/lifecycle-and-yield.mjs` — vault lifecycle + real yield; share value rises from loan interest.
- `vault/gated-private.mjs` — tfVaultPrivate vault bound to a domain; member deposit succeeds,
  outsider and unaccepted-credential holder rejected with tecNO_AUTH (depositors/share holders
  gated, not borrowers).
- `broker/first-loss-cover.mjs` — loan broker + first-loss cover minimum.
- `loan/origination-and-repayment.mjs` — dual-signed LoanSet + repayment + tfLoanFullPayment rules.
- `loan/impairment-default-recovery.mjs` — impair, default, first-loss recovery, timing guards.
- `loan/guardrails.mjs` — 8 guardrail rejections (A-H), each with a positive control.
- `credentials/issuance.mjs` — CredentialCreate + CredentialAccept; one instance per subject,
  keyed by (Issuer, Subject, CredentialType), lsfAccepted set only after accept.
- `credentials/permissioned-domain.mjs` — PermissionedDomainSet with the wrapped
  `{ Credential: { Issuer, CredentialType } }` accepted list; standalone membership proof.
- `mpt/issuance.mjs` — MPTokenIssuanceCreate (CanTransfer + RequireAuth + CanEscrow); two-step
  auth (holder opt-in + issuer authorize); positive balance only after both steps.
- `mpt/asset-vault.mjs` — Single Asset Vault over an MPT; Scale omitted (reads 0); MPT
  deposit/withdraw round-trip; explicit Scale on an MPT asset rejected client-side.
- `mpt/loan-flow.mjs` — full loan (originate + repay) in an MPT vault; PrincipalRequested string
  vs LoanPay MPT-amount object; payment must round UP to a whole base unit.
- `escrow/token-basics.mjs` — MPT escrow: lock, finish to destination (crypto-condition), cancel
  back to owner; early finish tecNO_PERMISSION, wrong fulfillment tecCRYPTOCONDITION_ERROR.
- `escrow/collateralized-origination.mjs` — collateral locked in escrow to the broker owner;
  application gate verifies the validated escrow before LoanSet; no on-chain escrow<->loan link
  (Loan object does not expose Data); mapping kept in application state.
- `escrow/default-and-claim.mjs` — LoanManage default (first-loss cover liquidated) then a
  SEPARATE EscrowFinish claims collateral to owner; non-atomic, release not gated on default.

## Verified findings (baked into `lib/`)
- `LoanBrokerSet` requires `Account == Vault.Owner` (else `tecNO_PERMISSION`).
- LoanSet counterparty signing needs the `CPT` (`CounterpartyTxSign`) hash prefix, which this
  build verifies against. `xrpl@5.2.0-beta.1`'s `signLoanSetByCounterparty` produces it
  (`5.1.0` used the wrong `STX` prefix and was rejected).
- Interest is **cash-basis** (`LendingProtocolV1_1`): recognized on `LoanPay`, not at origination.
- Loan payment fields are already in the asset base unit (drops) with a fraction; round **up** to
  the next integer. For an **MPT** vault the sub-unit shortfall is not tolerated: a truncated-down
  `LoanPay` fails `tecINSUFFICIENT_PAYMENT`, unlike the XRP drops case below.
- `VaultWithdraw` with the **share MPT** amount redeems all shares (full value); a bare asset
  amount withdraws assets and leaves yield behind.
- MPToken balance model: `MPTAmount` is the **spendable** balance; `LockedAmount` is the
  escrow-locked amount, still owned but not spendable. They are additive (total owned =
  `MPTAmount + LockedAmount`), so do **not** subtract `LockedAmount` from `MPTAmount`.
- Token escrow: MPT escrow between non-issuers needs `tfMPTCanEscrow` + `tfMPTCanTransfer`.
  `EscrowFinish` before `FinishAfter` → `tecNO_PERMISSION`; a wrong `Fulfillment` →
  `tecCRYPTOCONDITION_ERROR`. `EscrowCreate` has no `Data` field.
- No escrow↔loan binding: `LoanSet` does not verify any escrow; the `Loan` object does **not**
  expose a `Data` field even when `LoanSet.Data` is set, and neither object references the other.
  Collateral enforcement is application logic; keep the mapping in application state.
- Default recovery: `DefaultCovered = min(DebtTotal * CoverRateMinimum * CoverRateLiquidation,
  DefaultAmount, CoverAvailable)`; cover moves to the vault and the residual is a realized
  `AssetsTotal` loss. After default, `CoverAvailable`/`DebtTotal` may read absent (XRPL omits
  zero-valued fields) — treat missing as `0`.
- Guardrail codes: liquidity/cover `tecINSUFFICIENT_FUNDS`; caps `tecLIMIT_EXCEEDED`;
  late-without-flag `tecEXPIRED`; real underpayment `tecINSUFFICIENT_PAYMENT` (a sub-drop
  truncation alone is accepted). Impair/default timing violations → `tecTOO_SOON`.
