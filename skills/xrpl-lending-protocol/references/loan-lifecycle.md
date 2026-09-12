# Loan lifecycle (XLS-66 master)

Source: XLS-66 master §3.1, §3.8, §3.10, §3.11.
https://github.com/XRPLF/XRPL-Standards/blob/master/XLS-0066-lending-protocol/README.md

## Ledger objects
- `LoanBroker` (LedgerEntryType 0x0088): fields `VaultID`, `Owner`, `Account` (pseudo-account),
  `LoanSequence`, `DebtTotal`, `DebtMaximum`, `CoverAvailable`, `ManagementFeeRate`,
  `CoverRateMinimum`, `CoverRateLiquidation`. Costs 2 owner reserves.
- `Loan` (LedgerEntryType 0x0089): id = hash(namespace, `LoanBrokerID`, `LoanBroker.LoanSequence`).
  Borrower pays 1 owner reserve.

## LoanSet — key fields (§3.8.1)
Required: `LoanBrokerID`, `PrincipalRequested`, `CounterpartySignature`.
Optional: `Counterparty`, `Flags` (`tfLoanOverpayment 0x00010000`), `Data`,
`LoanOriginationFee`, `LoanServiceFee`, `LatePaymentFee`, `ClosePaymentFee`, `OverpaymentFee`,
`InterestRate`, `LateInterestRate`, `CloseInterestRate`, `OverpaymentInterestRate`,
`PaymentTotal` (default 1), `PaymentInterval` (≥60 s, default 60), `GracePeriod`
(≥60 s and ≤`PaymentInterval`).

**Rate fields are annualized, in 1/10th basis points** (0–100000 = 0–100%).

## Origination (§3.8.6)
On `LoanSet`:
- `Vault.AssetsAvailable −= PrincipalRequested`.
- `Vault.AssetsTotal += InterestDue` (interest booked at origination — **accrual basis** in
  merged master).
- `LoanBroker.DebtTotal += PrincipalRequested + InterestDue`; `LoanBroker.LoanSequence += 1`.
- Borrower receives `PrincipalRequested − LoanOriginationFee`; the fee goes to `LoanBroker.Owner`.

No separate drawdown step exists.

## Repayment — LoanPay (§3.11)
A payment splits into `principalPaid`, `interestPaid`, `feePaid`. `principalPaid + interestPaid`
returns to the vault pseudo-account; fees go to the broker (or into the cover pool if cover is
below minimum). Flags (mutually exclusive): `tfLoanFullPayment 0x00020000`,
`tfLoanLatePayment 0x00040000`, `tfLoanOverpayment 0x00010000`.

Loan fields to read: `PrincipalOutstanding`, `TotalValueOutstanding`, `ManagementFeeOutstanding`,
`PeriodicPayment`, `NextPaymentDueDate`, `PreviousPaymentDueDate`, `PaymentRemaining`, `LoanScale`.

## Impair / default — LoanManage (§3.10)
- **Impair** (`tfLoanImpair`): `Vault.LossUnrealized += TotalValueOutstanding −
  ManagementFeeOutstanding`; sets `lsfLoanImpaired 0x00020000`. Cleared by `tfLoanUnimpair` or
  automatically on the next payment.
- **Default** (`tfLoanDefault`): sets `lsfLoanDefault 0x00010000`;
  `DefaultCovered = min(DebtTotal × CoverRateMinimum × CoverRateLiquidation, DefaultAmount,
  CoverAvailable)`; the vault absorbs `DefaultAmount − DefaultCovered`; `DefaultCovered` moves
  from the cover pool to the vault.

## Minimum demo flow (Track 1, first-loss institutional credit)
1. `VaultCreate` (open-ended) → `VaultDeposit` from one or more lenders.
2. `LoanBrokerSet` → `LoanBrokerCoverDeposit` (first-loss capital).
3. `LoanSet` with `CounterpartySignature` (broker + borrower) → borrower drawn principal.
4. `LoanPay` at least once.
5. `VaultWithdraw` capital + yield.
6. Force a guardrail rejection (see result-codes) and/or `LoanManage` impair → default to show
   first-loss cover absorbing the loss.
