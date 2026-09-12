# Result codes and the merged/draft boundary (XLS-65/66)

Codes below are transcribed from the XLS-65/66 failure-condition tables in merged `master`.
https://github.com/XRPLF/XRPL-Standards/blob/master/XLS-0066-lending-protocol/README.md

## Guardrails you can demonstrate (merged master)

Insufficient liquidity / funds:
- `VaultWithdraw` with `AssetsAvailable < Amount` (or too few shares) → **`tecINSUFFICIENT_FUNDS`**.
- `LoanSet` with `Vault.AssetsAvailable < PrincipalRequested` → **`tecINSUFFICIENT_FUNDS`**.
- `VaultDeposit` over `AssetsMaximum` → **`tecLIMIT_EXCEEDED`**; depositor can't cover →
  **`tecINSUFFICIENT_FUNDS`**.

Out-of-schedule / timing:
- `LoanPay` amount below `periodicPayment + loanServiceFee` → **`tecINSUFFICIENT_PAYMENT`**.
- `LoanPay` late without `tfLoanLatePayment` → **`tecEXPIRED`**.
- `LoanPay` on a fully-paid loan, or `tfLoanFullPayment` on the final payment → **`tecKILLED`**.
- `LoanManage` default before the grace period ends → **`tecTOO_SOON`**.

First-loss cover:
- `LoanSet` when cover `< (DebtTotal + PrincipalRequested + InterestDue) × CoverRateMinimum` →
  **`tecINSUFFICIENT_FUNDS`**.
- `LoanBrokerCoverWithdraw` that would drop cover below `DebtTotal × CoverRateMinimum` →
  **`tecINSUFFICIENT_FUNDS`**.
- `LoanSet` / `LoanBrokerSet` over `DebtMaximum` → **`tecLIMIT_EXCEEDED`**.

Other common codes: `temMALFORMED` / `temBAD_AMOUNT` / `temINVALID_FLAG` / `temDISABLED`
(data-check stage), `tecNO_ENTRY` (missing object), `tecNO_PERMISSION` (wrong signer/owner),
`tecNO_AUTH` (permissioned-domain / credential gate), `tecWRONG_ASSET`, `tecFROZEN` / `tecLOCKED`,
`tecPRECISION_LOSS`, `tecHAS_OBLIGATIONS` (non-empty delete), `tecINSUFFICIENT_RESERVE`.

## ⚠ The merged / draft boundary — do not present drafts as shipped

Merged `master` = single-transaction `LoanSet` with `CounterpartySignature`, accrual-basis
origination, open-ended vaults only. The following are **open, unmerged PRs**; treat them as
proposals and confirm amendment status at https://xrpl.org/resources/known-amendments :

- **Closed-ended vault** (PR #587): adds `VaultKind` (0 open / 1 closed), `SubscriptionDate`,
  `RedemptionDate`, and the three phases. Wrong-phase codes from that draft: out-of-phase
  `VaultDeposit` → `tecEXPIRED`; `VaultWithdraw` during Investment → `tecTOO_SOON`; `LoanSet`
  before subscription ends → `tecTOO_SOON`, after redemption → `tecEXPIRED`, loan maturing past
  `RedemptionDate` → `tecNO_PERMISSION`.
- **Two-step `LoanAccept` + cash-basis accounting** (PR #570, amendment `LendingProtocolV1_1`):
  broker proposes a pending `Loan` (`lsfLoanPending 0x00080000`), borrower accepts with a new
  `LoanAccept` transaction. A cash-basis vault does **not** add interest to `AssetsTotal` at
  origination (interest recognized on payment). The field that selects cash-basis vs accrual is
  **not defined in the readable spec text** — do not assume it is tied to `VaultKind`. `LoanAccept`'s
  `tt` number is not confirmed — do not invent one.
