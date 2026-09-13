# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** AAA   **Event:** btf-paris-2026-09
**Coverage:** compacted, period 12:15:10Z to 14:45:53Z. The session was compacted twice in the window, so early detail came from the hook buffer (.xrpl-devex/sent.jsonl, 120 rows this session/period) plus the post-compaction transcript in context. Raw transaction blobs and full error strings were not all retained.
**Features touched:** xls-65 (Single Asset Vault), xls-66 (Loan Broker, first-loss cover, loan lifecycle). Incidental: credentials, mpt, permissioned-domains shapes appeared in tool results with no recorded friction.
**What was attempted:** Implement and verify live the Part 1 lending flow (vault lifecycle and yield, broker and first-loss cover, loan origination and repayment, impairment/default/recovery, guardrail gallery), then refactor the phases onto shared builders and upgrade the SDK. Work ran against the lending hackathon devnet.

## Top 3 friction points
1. **LoanSet counterparty signature rejected by the SDK (sdk).** `signLoanSetByCounterparty` in xrpl.js 5.1.0 signs the counterparty signature with the standard transaction prefix (STX) instead of the CounterpartyTxSign prefix (CPT) this build verifies, so every dual-signed LoanSet was rejected ("Counterparty: Invalid signature", then `temBAD_SIGNER`). Hook: one `retry_resolved` for LoanSet, attempts 2, elapsed 5859 s (~98 min); 16 LoanSet tool results in the period. Resolved only by upgrading to the experimental `xrpl@5.2.0-beta.1`, which adds a `counterparty` signing role that uses the CPT prefix. This single issue dominated the period's lost time.
2. **`tecINSUFFICIENT_FUNDS` on `LoanBrokerCoverWithdraw` actually meant a cover-ratio breach, not a balance shortfall (protocol/error_message).** Logged reflection: CoverAvailable was 30 XRP and the withdraw 11 XRP, so funds were sufficient; the rejection came from the invariant CoverAvailable >= DebtTotal * CoverRateMinimum / 100000 (required 20 XRP against 40 XRP debt at CoverRateMinimum 50000). The generic code sends you to check balances first. A smaller 5 XRP withdraw that kept cover at or above the minimum succeeded; the rejected tx still landed as a validated tec with the fee consumed.
3. **Cash-basis interest contradicted the initial accrual model (protocol/wrong_model).** On this build (LendingProtocolV1_1) interest is recognized on `LoanPay`, not at `LoanSet`: at origination `AssetsAvailable` drops by the drawn principal while `AssetsTotal` is unchanged. The plan had assumed accrual at origination; live assertions in the origination/repayment phase forced the correction. Easy to get wrong because many lending systems accrue at origination.

## Documentation gaps
No verbatim developer doc question was captured in this period (the one `prompt` row in the window was omitted as `no_signal`). Open questions that the record implies, but that were resolved by source reading or trial rather than docs:
- Which signing prefix does LoanSet's CounterpartySignature require, and which xrpl.js version produces it.
- Whether interest on this build is cash-basis or accrued at origination.
- The exact recovery identity on default (covered vs realized loss).

## Wrong assumptions
- Interest accrues at origination. Wrong here: it is cash-basis (recognized on payment). See Top 3 #3.
- A `tecINSUFFICIENT_FUNDS` on cover withdraw is a balance problem. Wrong: it is a cover-ratio invariant. See Top 3 #2.

## Error messages worth improving
| result code | actual mistake | pointed at cause (1-5) |
|---|---|---|
| temBAD_SIGNER | LoanSet counterparty signature produced with the wrong prefix by xrpl.js 5.1.0; the real fix was an SDK version, not the signer account | 2 |
| tecINSUFFICIENT_FUNDS (LoanBrokerCoverWithdraw) | cover-ratio invariant breach; funds were sufficient | 2 |
| tecTOO_SOON (LoanManage) | impair/default attempted before the timing window; code names the cause reasonably well | 4 |

## Abandoned
- A manual CPT-prefix counterparty-signing workaround (hand-built with ripple-keypairs) was started, then dropped once `xrpl@5.2.0-beta.1` fixed the SDK helper. Blocked at: superseded by the beta upgrade.

## Workarounds
- Upgraded to the experimental dist-tag `xrpl@5.2.0-beta.1` to get CPT-prefix counterparty signing. Should be provided by: sdk (a stable release with the correct prefix).

## Timeline
- LoanSet: ~98 min to first success (hook `retry_resolved` elapsed 5859 s, attempts 2). Source: hook.
- VaultCreate, VaultDeposit, LoanBrokerSet, LoanBrokerCoverDeposit, LoanPay: succeeded in the period (tesSUCCESS observed) with no recorded retry; per-type time-to-first-success not separately timed. Source: hook.

## Not observed
- The cause of a `Payment` `tecINSUFFICIENT_FUNDS` at 13:20:31Z was not determinable from the retained record (possibly a reserve or funding issue); not counted.
- Whether the `LoanSet` `temBAD_SIGNER` at 14:45:52Z was residual signing friction or an intentional negative control (the guardrail phase submits deliberately failing LoanSets); not counted as friction.
- No developer verbatim questions were retained for the period (prompt text omitted as no_signal); doc-gap items above are inferred, not quoted.
- Whether the developer used other Claude sessions or tools in the period (checkpoint mode: not asked).
