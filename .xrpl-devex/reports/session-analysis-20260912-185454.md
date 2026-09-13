# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** aaa   **Event:** btf-paris-2026-09
**Coverage:** compacted. The implementation work (XLS-70/80/65/33/85 reference flows) is in the live transcript and hook buffer. Additional public-Devnet comparison probes (closed-ended vaults, faucet differences, cross-build checks) appear only as hook reflection rows from parallel probe scripts run in this window, not in the main transcript, so their exact attempts and timings are not independently observed.
**Features touched:** xls-70 (credentials), xls-80 (permissioned domains), xls-65 (single asset vault), xls-33 (MPT), xls-85 (token escrow), xls-66 (lending).
**What was attempted:** Author and run end-to-end reference flows for the full lending stack: credential issuance and permissioned-domain membership, a credential-gated private vault, MPT issuance with two-step auth, an MPT-asset vault, an MPT-denominated loan, and token-escrow collateral (lock, finish, cancel, default-then-claim). In parallel, probe scripts compared the hackathon Devnet against public Devnet.

## Top 3 friction points
1. **MPT LoanPay must round the periodic payment UP; a floored value fails.** The live loan exposed `PeriodicPayment = 1000114.155251137273` while an MPT `Amount` only accepts whole base units. Paying the floor (`1000114`) returned `tecINSUFFICIENT_PAYMENT`; the rounded-up `1000115` succeeded. This is the opposite of an XRP-drops vault, where a sub-unit truncation is tolerated. The asymmetry is silent and easy to get wrong on every MPT repayment. (wrong_model, protocol/xls-66, observed)
2. **`LoanBrokerSet` on an open-ended vault: accepted on one build, `tecNO_PERMISSION` on another.** Hackathon rippled 3.4.0-rc1 accepts `LoanBrokerSet` on an open-ended vault; public Devnet 3.4.0-rc5 rejects the identical transaction with `tecNO_PERMISSION` even though `Account` exactly equals `Vault.Owner`. The code points at ownership, which is correct, so time went into chasing a false ownership bug rather than a build/vault-kind policy difference. (error_message, protocol/xls-66, observed via parallel probe)
3. **Vault `DomainID` lives on the share MPTokenIssuance, not the vault.** A private vault's domain binding reads at `vault.shares.DomainID`, not a top-level `Vault.DomainID`. An assertion against the vault object failed until the field was found under `shares`. Related: for an MPT-asset vault, `VaultCreate` must OMIT `Scale` entirely (sending `Scale: 0` fails client-side validation and is not normalized), and `Asset` is `{ mpt_issuance_id }` with no value while deposit/withdraw `Amount` carries the value. (wrong_model / doc_gap, protocol+sdk/xls-65, observed)

## Documentation gaps
No verbatim developer doc-questions were captured this period; the work was autonomous implementation, so gaps are inferred from failures rather than quoted. The gaps that cost time:
- Where a private vault stores its `DomainID` (on the share issuance, not the vault object).
- That `PermissionedDomainSet.AcceptedCredentials` needs the wrapped `[{ Credential: { Issuer, CredentialType } }]` form; the flat `{ Issuer, CredentialType }` is rejected.
- That `CredentialType` and `URI` must be hex (`convertStringToHex`); plain text fails local validation.
- That an MPT `LoanPay` must round up to a whole base unit, unlike XRP drops.

## Wrong assumptions
- Sub-unit truncation of a loan payment is tolerated (true for XRP drops, false for MPT).
- A private vault exposes `DomainID` at the vault top level (it is on the share issuance).
- `MPToken` spendable balance is `MPTAmount - LockedAmount` (wrong: `MPTAmount` is already spendable and `LockedAmount` is additive, so total owned = `MPTAmount + LockedAmount`).
- A missing `Fulfillment` on a conditioned escrow would yield a `tec` (it is `temMALFORMED` at submission; a wrong fulfillment is the clean `tec`).

## Error messages worth improving
| result code | actual mistake | pointed at cause (1-5) |
| --- | --- | --- |
| tecINSUFFICIENT_PAYMENT (LoanPay) | paid the floor of a fractional MPT `PeriodicPayment`; must round up to a whole base unit | 3 |
| tecNO_PERMISSION (LoanBrokerSet) | build/vault-kind policy on rc5, not an ownership problem; `Account == Vault.Owner` | 2 |
| tecNO_PERMISSION (EscrowFinish) | finish attempted before `FinishAfter`; generic permission, not "too early" | 3 |
| tecCRYPTOCONDITION_ERROR (EscrowFinish) | wrong `Fulfillment` supplied; clear and specific | 5 |
| temMALFORMED (EscrowFinish) | `Fulfillment` omitted on a conditioned escrow; generic malformed | 3 |
| tecINSUFFICIENT_FUNDS (LoanBrokerCoverWithdraw) | cover-ratio invariant breach, not a balance shortfall (CoverAvailable was ample) | 2 |
| tecNO_AUTH (VaultDeposit) | intended gate: non-member / unaccepted credential (negative control) | 4 |

## Abandoned
- Top-level `Vault.DomainID` assumption for a private vault (moved to `vault.shares.DomainID`).
- `MPTAmount - LockedAmount` as the spendable balance (abandoned once the additive model was confirmed).
- A missing-`Fulfillment` negative control for `EscrowFinish` (temMALFORMED at submission; switched to a wrong fulfillment for a clean tec).

## Workarounds
- Manual round-up of the loan's high-precision `PeriodicPayment`/`TotalValueOutstanding` to a payable whole base unit (`roundUpToAssetUnit`); no SDK helper does this.
- Hand-built PREIMAGE-SHA-256 condition and fulfillment, because xrpl.js bundles no crypto-conditions helper.

## Timeline
Time-to-first-success per tx type is not reported: these are authored reference flows run once live, not iterative first-contact, so per-type timings would be guesses. Recurring cost in the window: validated-ledger and submit requests to the Devnet timed out several times mid-flow (guardrail run aborted and was re-run; an MPT collateralized-origination `LoanSet` submit timed out once and succeeded on re-run; a multi-transaction public-Devnet flow stopped on a validated-ledger timeout). Each cost a full re-run.

## Not observed
- No verbatim developer XRPL doc-questions this period (autonomous implementation).
- Public-Devnet comparison, closed-ended vault timing (SubscriptionDate/RedemptionDate min 180s), faucet payload differences, and the `LoanBrokerCoverWithdraw`/`temBAD_SIGNER` notes are hook reflection rows from parallel probe scripts; exact attempts/timings for those were not independently observed in the transcript.
- Whether the `tecNO_PERMISSION` `LoanBrokerSet` divergence is an intentional rc5 policy change or a regression was not determined.
- The repository restructure (moving `impl/` to `packages/lending-flows/`) took much of the later window and is not XRPL friction.
