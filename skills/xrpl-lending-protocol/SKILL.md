---
name: xrpl-lending-protocol
description: "Build an XLS-66 Lending Protocol flow on top of an XLS-65 vault: loan broker, first-loss capital, dual-signed loans, repayment, impairment and default. Use when setting up a LoanBroker, depositing first-loss cover, originating a loan with CounterpartySignature, calling LoanPay, or handling impair/default with LoanManage on the XRP Ledger."
allowed-tools: Read Bash WebFetch Grep Glob
---

# XRPL Lending Protocol (XLS-66)

A `LoanBroker` sits on top of one XLS-65 vault. The broker posts first-loss capital, originates
term loans that draw the pooled asset to a borrower, collects repayments back into the vault,
and marks loans impaired or defaulted. This skill is the loan half of a lending project; the
pool half is in `xrpl-single-asset-vault`.

Build against the **merged `master` spec**:
https://github.com/XRPLF/XRPL-Standards/blob/master/XLS-0066-lending-protocol/README.md

## When to Use
- Creating a `LoanBroker` and funding its first-loss cover pool.
- Originating a loan signed by both broker and borrower.
- Taking a repayment, or marking a loan impaired / defaulted.
- Debugging a rejected loan, payment, or cover withdrawal.

## When NOT to Use
- **The pool itself** (deposits, withdrawals, share price) — use `xrpl-single-asset-vault`.
- **Two-step `LoanAccept`, cash-basis accounting, closed-ended phases** (Track 2 / "V1.1").
  These are **open, unmerged PRs** (#570 two-step + cash-basis, #587 closed-ended), not shipped
  protocol. See [references/result-codes.md](references/result-codes.md) for the boundary and
  confirm with a mentor which are enabled on the event network before coding them.

## Transactions (merged master)

| Transaction | `tt` | Purpose |
|---|---|---|
| `LoanBrokerSet` | 74 | Create / update the broker (rates, `DebtMaximum`, cover rates). |
| `LoanBrokerDelete` | 75 | Delete the broker. |
| `LoanBrokerCoverDeposit` | 76 | Add first-loss capital to the cover pool. |
| `LoanBrokerCoverWithdraw` | 77 | Remove cover (blocked below the minimum). |
| `LoanBrokerCoverClawback` | 78 | Issuer-only clawback of cover. |
| `LoanSet` | 80 | Originate a loan. Principal is drawn to the borrower **inside this transaction**. |
| `LoanDelete` | 81 | Delete a settled loan. |
| `LoanManage` | 82 | Impair / unimpair / default (via flags). |
| `LoanPay` | 83 | Make a scheduled, late, full, or over-payment. |

**Naming corrections (common wrong models):**
- There is **no `LoanDraw` / drawdown transaction.** Drawdown happens inside `LoanSet` — the
  borrower receives `PrincipalRequested − LoanOriginationFee` when the loan is created.
- There is **no `LoanRepay`.** Repayment is `LoanPay`.
- **Impairment and default are flags on `LoanManage`**, not their own transactions
  (`tfLoanImpair 0x00020000`, `tfLoanUnimpair 0x00040000`, `tfLoanDefault 0x00010000`).

## The dual-signature loan (merged master, not a two-step accept)

A loan needs both the broker side and the borrower (counterparty). In merged master this is a
**single transaction** carrying two signatures, not a propose/accept pair:

1. The initiator signs `LoanSet` normally (`SigningPubKey` / `TxnSignature`, or `Signers`).
2. The counterparty's approval goes in a dedicated inner field **`CounterpartySignature`**
   (an `STOBJECT` with `SigningPubKey` + `TxnSignature`, or a `Signers` list). `CounterpartySignature`
   is itself excluded from the primary signature.
3. Either party may initiate; the other verifies the terms and fills `CounterpartySignature`.
4. Fee is at least `2 × base_fee` (extra signature).

**xrpl.js helpers** (from 4.6.0; your scaffold's 5.x has them): `signLoanSetByCounterparty`
and `combineLoanSetCounterpartySigners`. Use these rather than hand-building the inner object.
The full origination → repayment → impair/default lifecycle and field list is in
[references/loan-lifecycle.md](references/loan-lifecycle.md).

## First-loss capital
Three `LoanBroker` fields govern it: `CoverAvailable`, `CoverRateMinimum` (fraction of
`DebtTotal` that must stay covered), `CoverRateLiquidation` (fraction of the minimum liquidated
per default). If `CoverAvailable` falls below `DebtTotal × CoverRateMinimum`, the broker **cannot
originate new loans and stops receiving fees directly** (fees route into the cover pool).
Mechanics and the default-coverage formula are in
[references/first-loss-and-defaults.md](references/first-loss-and-defaults.md).

## Loaded primitives (optional)
For a "Loaded" submission, the natural add-ons and the extra code surface each opens are in
[references/loaded-primitives.md](references/loaded-primitives.md): Permissioned Domains +
Credentials, MPTs, TokenEscrow, and sponsored fees/reserves.

## Result codes
The guardrail codes a developer actually hits (insufficient liquidity, out-of-schedule payment,
cover below minimum, debt cap) are in [references/result-codes.md](references/result-codes.md).
Rate fields are **annualized, in 1/10th basis points** (0–100000 = 0–100%); getting the unit
wrong is the most common origination error.
