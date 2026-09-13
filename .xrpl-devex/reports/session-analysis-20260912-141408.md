# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** aaa   **Event:** btf-paris-2026-09
**Coverage:** compacted. This turn (Phase 1.1 implementation and endpoint recovery) is fully visible in context. Earlier vault/plan work in the same period was compacted; hook evidence (292 in-window rows) supplies aggregate tx and result-code counts for that part.
**Features touched:** xls-65, xls-66, mpt, permissioned-domains, token-escrow
**What was attempted:** Build and run the first-loss institutional-credit vault flow (XLS-65 vault + XLS-66 loan broker, cover, loan, repayment, withdraw) end to end on the lending hackathon devnet, then correct the plan and skill docs against verified on-chain behavior.

## Top 3 friction points
1. **Documented Lending-Devnet endpoint is dead; the working faucet has a non-standard shape.** The skill and docs pointed at `wss://lend.devnet.rippletest.net:51233`, which does not resolve (DNS ENOTFOUND). The real network is `wss://lending-hackathon.dev.ripplex.io:51233`. Its faucet (`lending-hackathon-faucet.dev.ripplex.io/accounts`) generates and funds its own account and returns the secret, ignoring `destination`, so `xrpl.js` `Client.fundWallet` fails with "faucet account is undefined". Recovering the endpoint and funding path cost the most wall-clock time in the period.
2. **`signLoanSetByCounterparty` (xrpl.js 5.1.0) produces an invalid counterparty signature.** It signs over the standard `STX` transaction prefix, but this rippled (3.4.0-rc1) verifies the counterparty signature with a distinct `CPT` (`CounterpartyTxSign`) prefix. The LoanSet failed local checks with "Counterparty: Invalid signature". Fix required reading rippled `Sign.cpp` / `HashPrefix.h` and hand-rolling the signature with the `CPT` prefix.
3. **`tecNO_PERMISSION` on `LoanBrokerSet` did not point at the cause.** On public Devnet the broker creation failed with `tecNO_PERMISSION` even when the submitter was the vault owner (the only documented `tecNO_PERMISSION` path is "not the vault owner"). It succeeded on the hackathon devnet with the same code, so the code masked a build/network discrepancy rather than a permission error.

## Documentation gaps
- "What is the current Lending-Devnet WebSocket host and faucet?" The skill's host is dead and its faucet section says "no programmatic faucet host is documented"; the working host and its non-standard faucet contract were undocumented.
- "How do I co-sign a LoanSet as the counterparty against this build?" No doc states that the counterparty signature uses the `CPT` hash prefix, nor that the xrpl.js helper predates it.
- "Is lending interest accrual-basis or cash-basis here?" Not documented; verified empirically as cash basis under `LendingProtocolV1_1`.

## Wrong assumptions
- Interest is booked to `AssetsTotal` at origination (accrual). Observed: cash basis, interest recognized on `LoanPay`; `AssetsTotal` is unchanged at origination.
- `VaultWithdraw` `Amount` as XRP drops redeems shares. Observed: a bare asset amount withdraws that many assets and leaves yield behind; redeeming all shares requires the share MPT amount.
- Loan payment fields need re-scaling by `10^AssetScale`. Observed: they are already in the asset base unit (drops) with a fraction; the payment is a ceil-to-integer.

## Error messages worth improving
| result code | actual mistake | pointed at cause (1-5) |
|---|---|---|
| (local) "Counterparty: Invalid signature" | xrpl.js signed the counterparty sig with the wrong hash prefix (`STX` vs `CPT`) | 2 |
| tecNO_PERMISSION (LoanBrokerSet) | network/build discrepancy, not an ownership problem, on public Devnet | 1 |
| tecINSUFFICIENT_FUNDS (VaultDeposit) | deposited the account's entire balance, leaving nothing for reserve + fee | 3 |

## Abandoned
- Public Devnet (`s.devnet.rippletest.net`) as the target network: it carried the amendments but `LoanBrokerSet` returned `tecNO_PERMISSION` for the vault owner, so it was abandoned for the hackathon devnet.
- `Client.fundWallet` for funding: abandoned for a direct faucet POST plus `Wallet.fromSeed`.

## Workarounds
- Hand-rolled counterparty signing: `encodeForSigning(tx)`, swap the leading `53545800` for `43505400`, sign with the counterparty key, set `CounterpartySignature`. Should be provided by the SDK.
- Direct faucet POST + `Wallet.fromSeed(account.secret)` because the faucet ignores `destination`. Should be provided by the faucet/SDK contract.

## Timeline (elapsed to first success per tx type)
- VaultCreate, VaultDeposit, LoanBrokerSet, LoanBrokerCoverDeposit, LoanPay, VaultWithdraw: first success reached once the endpoint and amounts were correct (source: transcript; per-type minutes not separable).
- LoanSet: first success only after the `CPT`-prefix workaround, the single longest sub-task in the period (source: transcript).

## Not observed
- Exact per-transaction minutes and precise attempt counts for the compacted earlier work; hook aggregates show result codes `temMALFORMED` x3, `tecEXPIRED` x4, `tecLIMIT_EXCEEDED` x2, `temINVALID` x2, `tecKILLED` x1, `temBAD_SIGNER` x1 in the period, but their exact call sites are not visible in context.
- Whether a newer xrpl.js (5.2.0) fixes the counterparty prefix: not tested.
- Whether the developer used other Claude sessions or tools in the period: not determinable from the record.
