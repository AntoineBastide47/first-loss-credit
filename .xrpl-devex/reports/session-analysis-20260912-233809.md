# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** AAA   **Event:** btf-paris-2026-09
**Coverage:** partial. The period since 19:31Z is mostly visible in the transcript (an adversarial review, seven fixes, then a full MPT-market build) plus the hook buffer. The hook captured 119 tool_result rows with no failures, but stored most result codes as null and did not classify friction (all rows are `raw`). One earlier episode (a VaultWithdraw redeem that hung) is known only from the developer prompt and hook rows, not a captured error code.
**Features touched:** xls-65, xls-66, mpt, xls-85 (escrow collateral), xls-70/80 (credentials)
**What was attempted:** Hardened and extended an existing first-loss lending product: server-side validation of the operator co-signature on LoanSet, then a second, MPT-denominated market stood up live on devnet (MPT issuance, holder auth, mint, MPT-asset VaultCreate, deposit, LoanBrokerSet, cover deposit, and a demo LoanSet), plus asset-generic lender/borrow screens and read-only portfolio and tranche-waterfall views. Every on-chain transaction in this window succeeded on the first attempt.

## Top 3 friction points
1. **MPT amount-shape split (sdk, mpt/xls-65).** Standing up the MPT market means juggling three different shapes for the same token: the vault `Asset` is identity-only `{mpt_issuance_id}` with no value, deposit/withdraw/cover/LoanPay `Amount` is `{mpt_issuance_id, value}`, and `LoanSet.PrincipalRequested` is a plain base-unit string. These are easy to mix. I applied them correctly first try only because prior periods already surfaced them; a developer meeting them fresh would not. I ended up writing a small asset helper (build the correct Amount from asset + human value) as a workaround, which is direct evidence the shapes want an SDK helper.
2. **VaultWithdraw redeem hung with no signal (sdk/tooling, xls-65).** Verbatim (19:33Z): "Redeem does not work for any share number. It stays in the submitting state for a while and then goes back to default." A withdraw that neither confirms nor raises a visible engine result is a dead end: the developer cannot tell whether it was rejected, dropped, or is still pending. No result code was captured for it.
3. **Conceptual gap: is lending native to the chain? (docs, xls-66).** Verbatim (20:50Z): "Isn't this project already done on xrpl? Isn't this a basic of the chain?" The line between "native ledger feature" and "amendment (XLS-65/66) that must be enabled" is not obvious, even to someone already building on it.

## Documentation gaps
- "Isn't this project already done on xrpl? Isn't this a basic of the chain?" (xls-66, docs). The relationship between the Single Asset Vault / Lending Protocol amendments and base-ledger capabilities is unclear.
- No single worked recipe for provisioning an MPT-denominated market end to end. The eleven chained steps (issuance, authorize each holder, mint, VaultCreate with identity-only Asset, deposit, LoanBrokerSet, cover deposit, LoanSet) had to be assembled from separate reference pages.

## Wrong assumptions
- None newly observed in this period. The MPT-vault quirks (Scale must be absent on an MPT VaultCreate, LoanPay must round the periodic payment up to a whole base unit) were applied correctly because they were learned earlier, so they cost no time here.

## Error messages worth improving
| result code | actual mistake | pointed at cause (1-5) |
|---|---|---|
| (none) | No failing engine result was produced in this window. The one failure-like event, a hung VaultWithdraw, returned no code at all, which is the problem. | n/a |

## Abandoned
- None. All attempted transactions completed.

## Workarounds
- Hand-written asset abstraction that maps (asset descriptor, human value) to the correct XRP-drops string or MPT `{mpt_issuance_id, value}` object, to stop the amount-shape confusion above. Should be provided by the sdk.
- Off-ledger escrow-to-loan mapping and a desk-held crypto-condition fulfillment for collateral, because escrow has no on-chain link to a loan and release cannot be gated on default. Should be provided by the protocol.

## Timeline
Every transaction type exercised in this window (VaultCreate, VaultDeposit, VaultWithdraw, LoanSet x9, LoanPay, LoanManage, LoanBrokerCoverDeposit, MPTokenIssuanceCreate, MPTokenAuthorize, Payment, CredentialCreate/Accept, EscrowCreate/Finish) succeeded on the first attempt. The MPT market was seeded in a single script run of roughly two minutes. Precise per-transaction elapsed time was not captured by the hook (no retry_resolved rows, result codes stored as null), so first-success minutes are left null. Source: transcript, corroborated by hook for VaultDeposit (tesSUCCESS).

## Not observed
- Whether the VaultWithdraw hang was a wallet-adapter timeout, a dropped submission, or a rejected transaction: no engine result was recorded.
- Precise per-transaction latency (the hook did not record elapsed times or most result codes this period).
- Whether the developer worked in other Claude sessions or tools during the period (checkpoint mode does not ask).
