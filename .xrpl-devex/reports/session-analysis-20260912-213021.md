# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** aaa   **Event:** btf-paris-2026-09
**Coverage:** compacted. The interactive UI test (connect, deposit, yield, redeem) and the WalletConnect diagnosis/fix are in the live transcript and hook buffer. Some xrpl.js `validateLoanSet` findings come from parallel public-Devnet probe reflections in the buffer, not the main transcript, so their exact repro counts are not independently observed.
**Features touched:** xls-65 (vault deposit/withdraw), xls-66 (loan pay), plus the reference lending UI, `xrpl-connect`, and the hackathon browser wallet (tooling).
**What was attempted:** Drive the reference Vault Lender Console end to end against the hackathon devnet with the event's own browser wallet: connect over WalletConnect, deposit, watch derived share price rise from a loan repayment, and redeem. In parallel, probe scripts compared xrpl.js `validateLoanSet` against rippled preflight.

## Top 3 friction points
1. **WalletConnect signing fails on a custom network: chain-id mismatch.** The reference app builds its WalletConnect chain id from the network config; `xrpl-connect` falls back to `xrpl:${network.id}` (here `xrpl:lending-hackathon`) when a network has no `walletConnectId`. WalletConnect v2 moves `requiredNamespaces` into `optionalNamespaces` and empties the required set, so the wallet approves a session for only its OWN chain (`xrpl:0` for the dev wallet's manual/custom network). The dApp then calls `request({ chainId: 'xrpl:lending-hackathon' })`, which is not in the session, and it fails with "Missing or invalid. request() chainId: xrpl:lending-hackathon". This blocks every write flow. Fix: set `walletConnectId` on the custom network to match the wallet's advertised chain (`xrpl:0`). Diagnosing it meant reading `xrpl-connect` internals and the wallet source. (workaround, tooling, observed)
2. **xrpl.js `validateLoanSet` is too permissive.** On 5.2.0-beta.1 it accepts `GracePeriod` of 0, negative, or NaN, and `PaymentTotal` of 0, negative, or fractional, because the checks only test `isNumber`. Only the rippled preflight rejects these, so a malformed LoanSet passes client validation and fails later on-chain. (error_message, sdk/xls-66, observed via parallel probe)
3. **LoanSet with `Counterparty` but no `CounterpartySignature` is accepted client-side, then `temBAD_SIGNER` on-chain.** xrpl.js types both fields optional and `validateLoanSet` accepts the half-formed dual-signature shape, so the missing counterparty signature only surfaces as a ledger `temBAD_SIGNER`. (error_message, sdk/xls-66, observed via parallel probe)

## Documentation gaps
No verbatim developer doc-questions this period (autonomous work). Gaps inferred from failures:
- That a custom (non mainnet/testnet/devnet) network needs an explicit WalletConnect `walletConnectId`, and that WalletConnect v2 drops `requiredNamespaces` so the dApp chain must equal the wallet's chain.
- That the reference UI does not register the WalletConnect adapter unless `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set, so out of the box it cannot connect to the event's own WalletConnect wallet.

## Wrong assumptions
- That a WalletConnect wallet approves the dApp's requested chain id (it only approves its own; requiredNamespaces are not honored as hard requirements).
- That a plain `LoanPay` settles an overdue instalment (it needs `tfLoanLatePayment`; without it the ledger returns `tecEXPIRED`).

## Error messages worth improving
| result code | actual mistake | pointed at cause (1-5) |
| --- | --- | --- |
| temBAD_SIGNER (LoanSet) | Counterparty set without a CounterpartySignature; xrpl.js accepted the shape, ledger rejected it | 2 |
| tecEXPIRED (LoanPay) | overdue instalment paid without tfLoanLatePayment; the code does not say "add the late-payment flag" | 3 |
| (WalletConnect) "Missing or invalid. request() chainId: xrpl:lending-hackathon" | the session was approved for xrpl:0, not the requested chain; the error does not say the session lacks that chain | 2 |

## Abandoned
- Plain (non-late) `LoanPay` to inject yield — abandoned once the loan went overdue; switched to `tfLoanLatePayment`.

## Workarounds
- Added `walletConnectId: "xrpl:0"` to the app's custom hackathon network (in `networks.js` and the WalletManager network object) so the dApp signs on the chain the wallet actually approves. Belongs in `xrpl-connect` (custom-network chain handling) or the reference app template.

## Timeline
Time-to-first-success per tx type is not reported: the write path was blocked for a stretch by the WalletConnect chain-id bug (about 30 minutes from the first failed sign to a working deposit, spent reading xrpl-connect and wallet source), then the UI deposit validated on the first try after the fix. Yield injection took two tries: the first `LoanPay` returned `tecEXPIRED` (overdue), the second succeeded with `tfLoanLatePayment`.

## Not observed
- No verbatim developer XRPL doc-questions this period (autonomous UI testing and debugging).
- The xrpl.js `validateLoanSet` permissiveness and the `Counterparty`-without-signature `temBAD_SIGNER` are parallel public-Devnet probe reflections in the hook buffer; exact repro counts were not independently observed in the main transcript.
- Whether the dev wallet's manual/custom network actually submits to the hackathon WSS (vs only signing) was not separately confirmed; the deposit validating on the hackathon devnet is consistent with it.
- The redeem flows were set up but not yet executed at the time of this checkpoint.
