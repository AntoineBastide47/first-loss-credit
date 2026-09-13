# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** AAA   **Event:** btf-paris-2026-09
**Coverage:** compacted. The session ran 2026-09-12T09:49Z to 2026-09-13T10:11Z and was compacted six times, so only the last few hours are in the transcript verbatim. The gap is covered by 1173 hook events for this session, including 12 `retry_resolved` records with exact attempt counts and elapsed times, and 86 friction notes filed while the work was happening. Transaction level claims were re-checked against the devnet.
**Features touched:** xls-65, xls-66, xls-70, xls-80, xls-85, mpt, rlusd
**What was attempted:** A first-loss credit market: lenders deposit into an XLS-65 vault, borrowers draw from an XLS-66 loan broker, and a junior cover layer absorbs defaults before senior lenders. Day two added underwriting and risk based pricing from on-ledger history, loan terms from one day to five years, and a secondary market so lenders can exit a fully lent pool. Both XLS-65 and XLS-66 were exercised end to end and every transaction type has a verified receipt.

## Top 3 friction points

**1. The LoanSet counterparty signature, 5859 seconds to first success.** This is the single largest measured cost in the session and it is recorded precisely: two attempts, 5859 seconds, resolving a `temBAD_SIGNER`. The cause was that `signLoanSetByCounterparty` in xrpl.js 5.1.0 signed with the wrong hash prefix, so rippled rejected an otherwise correct signature. It was only fixed in 5.2.0-beta.1, which this project now pins for that reason alone. Three separate things made it hard: the SDK produced a signature the ledger would not take, `temBAD_SIGNER` reports signer duplication rather than a missing or mis-prefixed `CounterpartySignature`, and xrpl.js happily validates a LoanSet signing state that both devnets reject. Any team building on XLS-66 hits this.

**2. Ownership coupling means a wallet-created vault can never lend.** XLS-66 ties the broker owner, the vault owner, the `LoanSet` counterparty signer and the only account that may call `LoanBrokerCoverDeposit` to one account. Combined with point 1, no browser wallet can produce the counterparty signature, so a vault a user creates from their own wallet cannot originate a loan at all. This forced the whole architecture: a custodial desk account owns every vault, broker and loan object, and the real creator is recorded off-protocol in the vault's `Data` field as `{"n": name, "c": creator}` so that value-moving actions can be authorised against it. That is a large and permanent design concession made to work around a protocol constraint, not a preference.

**3. `tecNO_PERMISSION` is overloaded past the point of usefulness.** It appeared 19 times in this session across at least six distinct causes: an MPT escrow whose destination is not a member of the token's permissioned domain, an issuer opting in to its own issuance, `EscrowCancel` before `CancelAfter`, `EscrowFinish` before `FinishAfter` (a timing rule reported as a permission rule), `LoanBrokerSet` against an open-ended vault on one server, and `VaultClawback` where the underlying asset does not permit clawback. The escrow-domain case cost about 40 minutes on day two because [XLS-0085](https://xls.xrpl.org/xls/XLS-0085-token-escrow.html) lists exactly three causes for that code on an MPT escrow and none of them is domain membership, so the spec sends you to check flags that are all correctly set.

## Documentation gaps

Developer questions, verbatim:

- "what the fuck does Failed to sign transaction. Transaction failed on ledger: tecNO_AUTH mean ?" On a gated vault, `tecNO_AUTH` does not distinguish a credential that was never issued from one issued but not yet accepted. Both were hit.
- "I payed the 60.023975 XRP but earnings are only +0.000003 XRP, why ?" LendingProtocol V1.1 recognises interest only when a `LoanPay` validates, so a lender's position does not move until repayment lands. This cash-basis behaviour is not stated where a lender-facing integrator would look.
- "Is 30 days the max ? Can there not be a 1, 2, 3, 4, 5 year loan ?" The bounds on an XLS-66 repayment schedule are undocumented. Probing the devnet established `PaymentInterval >= 60` seconds, `GracePeriod <= PaymentInterval`, and no upper bound whatsoever: a 100 year term with 1200 payments was accepted with `tesSUCCESS`.
- "when I close the market, why is the vault still present and not deleted ?" `LoanBrokerDelete` succeeds while the vault still holds deposits, then `VaultDelete` fails with `tecHAS_OBLIGATIONS`, leaving an orphaned vault. Nothing warns that the two deletions have different preconditions.

Also filed during the compacted period: the closed-ended vault and cash-basis loan specs live only in unmerged PRs rather than master XLS-65/66; the XLS-66 README lists `LoanPay` as transaction type 83 while rippled and the xrpl.js codec use 84; `LoanBrokerSet` documents the wrong lower bound for `ManagementFeeRate`; the closed-vault brief omits the 180 second minimum investment period; and network capability checks do not reveal whether open-ended lending is permitted.

## Wrong assumptions

- That a large integer written to the ledger reads back in the same notation. `DebtMaximum` submitted as `"1000000000000"` returns as `"1e12"`, which `BigInt` rejects outright. This broke every market created that way and surfaced to the developer as a missing UI feature rather than a parse error.
- That `lsfMPTCanEscrow` being set was sufficient to escrow an MPT. Domain membership of the destination is also required and is not in the flag set.
- That `lsfMPTCanTrade` implied the token could be placed on the DEX. `OfferCreate.TakerGets` and `TakerPays` are typed `Amount`, which excludes MPT, so vault shares cannot be quoted on the native order book at all.
- That a vault owner can always wind a market down. `VaultClawback` requires the underlying asset to permit clawback: XRP has no clawback mechanism, and an MPT minted without `tfMPTCanClawback` cannot be recovered either. Three vaults are therefore permanently undeletable by their owner while any share is outstanding.
- That `CredentialType` names a reusable type object. It names a per-subject credential instance.

## Error messages worth improving

| result code | actual mistake | pointed at cause 1-5 |
|---|---|---|
| `temBAD_SIGNER` (LoanSet) | counterparty signature missing or signed without the CPT prefix; reported as signer duplication | 1 |
| `tecNO_PERMISSION` (EscrowCreate) | escrow destination is not a member of the MPT's permissioned domain; cause absent from XLS-0085 | 1 |
| `tecNO_PERMISSION` (EscrowFinish) | finish attempted before `FinishAfter`, a timing rule reported as a permission rule | 1 |
| `tecNO_PERMISSION` (LoanBrokerSet) | the vault is open-ended and that server does not allow open-ended lending | 1 |
| `tecINSUFFICIENT_FUNDS` (LoanBrokerCoverWithdraw) | withdrawal would breach `CoverRateMinimum`; the funds exist | 1 |
| `tecINSUFFICIENT_FUNDS` (various) | four distinct lending guardrails collapse to this one code | 1 |
| `tecNO_PERMISSION` (VaultClawback) | the vault's underlying asset does not permit clawback | 2 |
| `tecNO_PERMISSION` (MPTokenAuthorize) | an issuer opting in to its own issuance | 2 |
| `tecNO_PERMISSION` (EscrowCancel) | cancel attempted before `CancelAfter` | 2 |
| `tecNO_AUTH` (VaultDeposit) | credential missing versus issued but not accepted | 2 |
| `tecNO_AUTH` (Payment, MPT) | holder opt-in missing versus issuer approval missing | 2 |
| `tecLIMIT_EXCEEDED` | does not say whether the vault cap or the broker debt cap was exceeded | 2 |
| `tecHAS_OBLIGATIONS` (VaultDelete) | the vault still holds deposits | 4 |
| `tecINSUFFICIENT_PAYMENT` (LoanPay) | a genuine periodic payment shortfall, correctly specific | 5 |

## Abandoned

- RLUSD as the vault asset. It is Testnet-only while XLS-65/66 run on the lending devnet.
- Custodian-held share listings for gated vaults. Blocked at permissioned-domain membership: the custodian cannot legitimately be admitted to every market's compliance domain.
- Hard-deleting three vaults holding other people's deposits. Blocked at `VaultClawback`, which the underlying assets do not permit. Seven of ten vaults were deleted; three cannot be by anyone but their depositors.

## Workarounds

- A custodial desk owning every vault, broker and loan, with the creator recorded in vault `Data`, because the protocol will not let a wallet-owned vault lend. Should be provided by the protocol.
- Manual CPT-prefix signing for the LoanSet counterparty signature. Should be provided by the SDK.
- A parser that expands scientific notation before any XRPL number is converted to BigInt or formatted. Should be provided by the SDK.
- An escrow-based order book for vault shares, because the DEX cannot quote MPTs. Should be provided by the protocol.
- Crawling a broker's pseudo-account to read its loan book, and crawling known accounts with `account_objects` to discover vaults at all, since there is no index for either. Should be provided by the protocol.
- Overriding `navigator.onLine` so the bundled WalletConnect will attempt its relay: it gates 22 relay call sites on that flag alone and throws "No internet connection detected" without making any request. Should be provided by the SDK.
- Manual ceiling of decimal loan values to integer token units, since sub-unit `LoanPay` truncation is rejected for MPT vaults but tolerated for XRP vaults. Should be provided by the SDK.

## Timeline

Elapsed time from first attempt to first success, from the hook's `retry_resolved` records. These are the episodes where a retry was actually needed; transaction types absent from this table succeeded without a recorded retry.

| transaction type | attempts | time to first success | source |
|---|---|---|---|
| `LoanSet` | 2 | 98 minutes | hook |
| `VaultCreate` | 2 | 17 minutes, then 4 minutes on a second episode | hook |
| `LoanPay` | 2 | 14 minutes, then 25 seconds on a second episode | hook |
| `EscrowCreate` | 2 | 3 minutes | hook |
| `LoanBrokerSet` | 2 | 3 minutes | hook |
| `VaultClawback` | 2 | never succeeded | hook |
| `MPTokenIssuanceCreate` | 2 | 14 seconds | hook |
| `Payment` | 2 | 8 seconds | hook |
| `OfferCreate` | 2 | 2 seconds | hook |

Across the session the hook recorded 42 `tesSUCCESS` results and 41 failed tool results.

## Not observed

- Root cause of a `tecNO_PERMISSION` on `EscrowCreate` at ledger 90406 against a public vault. Checked at that exact ledger: issuance flags 56 with no `DomainID`, holder balance unlocked and intact, destination token present, both accounts `Flags: 0`, timings valid, metadata carrying only the fee. The identical transaction later simulated `tesSUCCESS` and three other accounts performed it successfully within minutes. Not reproducible, and not attributed to any protocol behaviour.
- Whether the 98 minute LoanSet resolution was mostly diagnosis or mostly waiting on the xrpl.js beta to become available.
- Successful instances of `CredentialAccept`, `CredentialDelete` and `EscrowCancel` were not located in the account histories searched for the receipt index, though all three are used.
- Whether the developer worked in other Claude sessions or tools during this period.
