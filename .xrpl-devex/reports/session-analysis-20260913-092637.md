# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** AAA   **Event:** btf-paris-2026-09
**Coverage:** full. The whole period is in the transcript, corroborated by 71 hook events (67 tool_result, 2 prompts). Every protocol claim below came from a transaction or query actually run against the hackathon devnet in this window.
**Features touched:** xls-65, xls-66, xls-70, xls-80, xls-85, mpt
**What was attempted:** Closing the gap between a working demo and a usable product: finding every lending object from the ledger rather than from browser storage, making a created market fully operable (impair, default, cover, collateral claim, wind-down), and tracking down three wrong numbers in the UI. Most of the period was spent probing XLS-65/66 semantics directly, because several behaviours could not be inferred from the SDK surface.

## Top 3 friction points
1. **Wallet adapters disagree on what `sign()` returns, and the mismatch fails silently (sdk, xls-66).** Building a dual-signed `LoanSet` needs the borrower's serialized blob so the counterparty can add its signature. In `xrpl-connect` the Crossmark adapter returns a real `tx_blob`, while the WalletConnect and GemWallet adapters put a bare signature (`TxnSignature` / `result.signature`) in the same `tx_blob` field. Nothing errors: the blob is simply not a transaction, and the failure surfaces much later as an unreadable payload server-side. The WalletConnect adapter actually receives the full signed `tx_json` from the wallet and discards everything except the signature, so the data needed is available and thrown away. Recovering it meant reaching past `sign()` into the adapter's own request method, then reconstructing the blob from `SigningPubKey` + signature as a fallback.
2. **`ManagementFeeRate` is on the 1e5 scale, and getting it wrong is silent (protocol/docs, xls-66).** Cover rates are 1e5 (100000 = 100%), and the fee shares that scale, but nothing says so and the value is accepted either way. A fee entered as 3% was written as `300` and silently became 0.3%, with the UI reading it back as "3.00%" so the error was self-consistent and invisible. It only surfaced by measuring a real repayment: fee 0.000028 against interest 0.000571 is 4.9%, not the 50% a 1e4 reading implies. A market can run for a long time charging a tenth of the intended fee with no signal at all.
3. **A settled loan keeps its schedule fields, so a repaid loan reads as overdue (protocol, xls-66).** After full repayment the Loan object stays on the ledger with `PrincipalOutstanding`, `TotalValueOutstanding` and `PaymentRemaining` all omitted (XRPL drops zero values), while fixed term fields like `PeriodicPayment` persist. Read naively, that is a loan owing nothing yet showing a payment due, and because `NextPaymentDueDate` is in the past it classifies as overdue or even "in default window". The consequence is worse than cosmetic: a UI can offer a payment button, and a loan book can offer to default a loan that was fully repaid.

## Documentation gaps
- "I payed the 60.023975 XRP but earnings are only +0.000003 XRP, why ?" (xls-65). Three separate mechanics had to be explained: interest accrues per second so an early payoff earns almost nothing, `LoanPay` debits only what is owed rather than the quoted schedule total, and yield is shared pro rata by share price.
- Where the management fee goes is undocumented and easy to get backwards. An initial reading of transaction metadata suggested it was accrued but never payable, because at sub-drop amounts the fee rounds to zero and never appears. It is in fact paid automatically to the broker owner on each repayment, which is why no fee-claim transaction exists.
- No documented way to enumerate lending objects. Loans are owned by the broker's **pseudo-account** (`broker.Account`), so `account_objects` on that address returns the book; nothing points at this, and without it a loan list can only be whatever the client happened to record.
- Several validation rules are discoverable only by failing: `InterestRate` must be 0..100000, and `GracePeriod` must not exceed `PaymentInterval`.

## Wrong assumptions
- That the management fee needed an explicit claim. It is paid automatically; the absence of a claim transaction is the design, not a gap.
- That `ManagementFeeRate` used the 1e4 scale that a percent-like value suggests.
- That an existing open vault could be gated later. `VaultSet` with `DomainID` on a non-private vault is rejected `tecNO_PERMISSION`; open vs gated is fixed by `VaultCreate`.

## Error messages worth improving
| result code | actual mistake | pointed at cause (1-5) |
|---|---|---|
| `tecNO_PERMISSION` | `VaultSet` adding `DomainID` to a vault not created private. Reads as an authorisation problem when it is really "this property is immutable". | 2 |
| `tecINSUFFICIENT_FUNDS` | Withdrawing more than `AssetsAvailable`: the assets exist but are lent out. "Insufficient funds" suggests a balance problem rather than a liquidity one. | 3 |
| (none) | A fee written at the wrong scale produces no error at all, just wrong economics. | 1 |

## Abandoned
- Clawback (`VaultClawback`, `LoanBrokerCoverClawback`) was left unexposed: it requires `tfMPTCanClawback` at mint, which these market tokens do not set, so any control would fail.
- Authenticating the caller of desk-side operations. Wallet adapters do not offer message signing (the WalletConnect adapter marks `signMessage` as not supported), so there is no way to prove wallet ownership to a server route. Value-moving actions were instead constrained by ledger state.

## Workarounds
- Reconstructing a signed transaction blob from a bare signature plus the account public key, because adapters return inconsistent shapes. Should be provided by the sdk.
- Reading the market's creator from the vault's `Data` field to authorise server-side actions, since no caller authentication is possible. Should be provided by the sdk (message signing in wallet adapters).
- Enumerating a loan book through the broker pseudo-account, and collateral through the borrower's escrow objects, because no index links these objects. Should be provided by the protocol.

## Timeline
Every transaction type in this window succeeded on the first attempt: `VaultSet` (5), `VaultDeposit` (4), `LoanSet` (3), `VaultCreate` (2), `EscrowCreate` (2), `Payment` (2), and one each of `LoanPay`, `LoanManage`, `EscrowFinish`, `MPTokenAuthorize`, `LoanBrokerDelete`. The one failing result, `tecINSUFFICIENT_FUNDS`, was a deliberate negative control on a cover withdrawal against an empty cover balance. Source: hook, corroborated by transcript. Time lost went to diagnosis rather than retries: the fee scale and the settled-loan reading each took a probe to isolate.

## Not observed
- Whether a fee paid at a visible size is credited anywhere other than the broker owner's wallet; only the owner balance was measured as changing.
- Whether `ledger_data` with `type: "vault"` can enumerate the whole ledger economically; it accepts the filter but returned a marker immediately, so only per-owner enumeration was measured.
- Whether adapters other than WalletConnect, GemWallet and Crossmark return a usable `tx_blob`.
- Whether the developer used other Claude sessions or tools during the period (checkpoint mode does not ask).
