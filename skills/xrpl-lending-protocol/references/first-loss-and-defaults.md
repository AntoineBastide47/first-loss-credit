# First-loss capital and defaults (XLS-66 master)

Source: XLS-66 master §3.1.11, §3.6, §3.7, §3.10.5.
https://github.com/XRPLF/XRPL-Standards/blob/master/XLS-0066-lending-protocol/README.md

First-loss capital is the broker's own money, held in the `LoanBroker` cover pool, that absorbs
losses before the vault's lenders do. It is what makes senior lenders "protected" in an
institutional-credit story.

## The three cover fields on `LoanBroker`
- `CoverAvailable` — current cover balance.
- `CoverRateMinimum` — fraction of `DebtTotal` that must stay covered (1/10 bps units).
- `CoverRateLiquidation` — fraction of the minimum cover liquidated per default (1/10 bps).

## The minimum-cover invariant
While `CoverAvailable < DebtTotal × CoverRateMinimum`:
- the broker **cannot originate new loans** (`LoanSet` fails, see result-codes), and
- the broker **stops receiving fees directly** — repayment fees route into the cover pool
  instead, rebuilding it.

Manage cover with `LoanBrokerCoverDeposit` (add) and `LoanBrokerCoverWithdraw` (remove — a
withdrawal that would breach the minimum is rejected).

## Default coverage formula
On `LoanManage` + `tfLoanDefault`:
```
DefaultCovered = min(DebtTotal × CoverRateMinimum × CoverRateLiquidation,
                     DefaultAmount,
                     CoverAvailable)
VaultLoss      = DefaultAmount − DefaultCovered
```
`DefaultCovered` transfers from the cover pool to the vault; the vault absorbs `VaultLoss` as a
realized loss. This is the moment to show in a demo: the first-loss pool takes the hit, senior
lenders are shielded up to the cover, and only the excess reaches the vault.

## "Do the parameters behave as their names suggest?" (event feedback question)
Watch for these when testing:
- `CoverRateMinimum` and `CoverRateLiquidation` are **rates in 1/10 bps**, not plain fractions.
  A value of `50000` means 50%, not 50000x.
- `CoverRateLiquidation` bounds how much of the *minimum* cover is liquidated per default, so a
  single default may not drain the whole pool even when `DefaultAmount` is large.
- After a default that routes fees to the pool, broker owner balances stop growing until cover
  is back above the minimum — easy to misread as a fee bug.
