# First-Loss Credit

A lending market on XRPL where senior lenders are protected by a junior first-loss layer.

Lenders deposit into an XLS-65 Single Asset Vault and earn borrower interest. Borrowers draw
loans from that vault through an XLS-66 Loan Broker. The broker carries first-loss cover: when
a loan defaults, the cover is liquidated to the vault before senior lenders take any loss, so
the junior capital absorbs the hit first. Anyone can launch a market of their own, set its fee
and minimum cover, and gate it to credential holders.

**Track 1.** Event: XRPL Lending Protocol Hackathon, `btf-paris-2026-09`.

## What it does

- **Earn.** Deposit into any market, watch utilisation and the first-loss layer beneath you,
  withdraw against idle liquidity, or sell your position on the share market when the pool is
  fully lent.
- **Borrow.** Pick how long to repay over and in how many payments. The desk quotes a rate and a
  limit from your on-ledger record before you type an amount, then counter-signs the loan.
- **Vaults.** Launch a market (XRP or an MPT you mint in the flow), fund its cover, admit
  depositors by credential, impair or default bad loans, claim collateral, take the management
  fee, and close the market.
- **Activity.** Everything your account has done across markets, read back from the ledger.

Nothing that matters is stored in the browser. Names, creators, positions and loan books are all
derived from ledger state, so a market opens the same way on any device.

### Underwriting

`/api/quote` prices and sizes every loan from ledger facts alone: your repayment record, any
collateral escrowed to the desk, whether you hold the market's credential, pool utilisation, and
the term you chose. `/api/originate` re-derives the same decision when the signed loan arrives
and refuses anything outside it, so the quote is a preview rather than a promise the server has
to keep. Rate = kinked utilisation curve + borrower tier spread + term premium − frequency
discount. Size = the smallest of your credit limit, idle liquidity, the broker's debt cap, the
first-loss cover, and the pool's long-dated budget.

## Why a custodial desk

XLS-66 ties three roles to one account: the broker owner must be the vault owner, must be the
`LoanSet` counterparty signer, and is the only account that can fund cover (anything else returns
`tecNO_PERMISSION`). The counterparty signature needs the `CounterpartyTxSign` prefix, which no
browser wallet adapter exposes. So a wallet-owned vault can never originate a loan.

The resolution: one desk account owns every vault, broker and loan object, and the real creator is
recorded on-ledger in the vault's `Data` as `{"n": name, "c": creator}`. Every value-moving server
action is authorised against that record rather than against whatever the caller claims, so cover
returns only to the creator and the credential gate can only ever point at them.

## Setup

Prerequisites: Node 18+ and pnpm 8+.

```bash
pnpm install
```

The desk needs a funded account on the hackathon devnet. Create one from the faucet:

```bash
curl -X POST https://lending-hackathon-faucet.dev.ripplex.io/accounts
```

Put its seed in `apps/web/.env.local` (gitignored, server-only, never shipped to the browser):

```
OPERATOR_SEED=s...
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...
```

Then set `OPERATOR` in `apps/web/lib/market.js` to that account's address, since the app only
counter-signs loans for markets the desk owns. Run it:

```bash
pnpm dev              # or: cd apps/web && npm run dev
```

The app is at http://localhost:3000. Connect a wallet with a Crossmark, GemWallet or Otsu browser
extension, or via WalletConnect. Fund a test wallet from the same faucet endpoint above.

### Verification flows

`packages/lending-flows` holds standalone scripts that prove each protocol behaviour end to end
against the devnet. Each builds its own vault, broker, lender and borrower, imports no other flow
and reads no other flow's state.

```bash
cd packages/lending-flows
node src/vault/lifecycle-and-yield.mjs
node src/loan/origination-and-repayment.mjs
node src/loan/impairment-default-recovery.mjs   # waits ~2-3 min for the timing windows
node src/loan/guardrails.mjs
node src/vault/gated-private.mjs
node src/mpt/asset-vault.mjs
```

## Environment

| | |
|---|---|
| Network | Lending Hackathon Devnet |
| WebSocket | `wss://lending-hackathon.dev.ripplex.io:51233` |
| Network ID | 4001 |
| rippled build | 3.4.0-rc1 |
| Faucet | `https://lending-hackathon-faucet.dev.ripplex.io/accounts` (POST, empty body, returns a new funded account) |
| Explorer | `https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233` |
| Reserves | 10 XRP base, 2 XRP per owned object |

The faucet ignores a `destination`, so `Client.fundWallet` does not work here: POST the endpoint
and use the account it returns.

## Library versions

| Package | Version |
|---|---|
| `xrpl` | 5.2.0-beta.1 |
| `xrpl-connect` | 0.8.2 |
| `next` | 16.3.4 |
| `react` | 19.3.0 |
| `tailwindcss` | 3.4.17 |

`xrpl@5.2.0-beta.1` is required: it is the first release whose `signLoanSetByCounterparty` signs
the counterparty signature with the correct `CounterpartyTxSign` prefix.

## XLS-65 transactions used

Single Asset Vault. All five that the app needs; `VaultClawback` is not used.

| Transaction | Where | Purpose |
|---|---|---|
| `VaultCreate` | `app/api/vault/route.js` (`create`) | Launch a market's vault. Sets `WithdrawalPolicy`, the name and creator in `Data`, optional `AssetsMaximum`, and for a gated market `tfVaultPrivate` + `DomainID`. |
| `VaultSet` | `app/api/vault/route.js` (`settings`) | Rename a market or change its deposit cap, rewriting `Data` so the name travels with the vault. |
| `VaultDeposit` | `app/earn/page.js` | A lender deposits and receives share MPTs. Signed by the lender. |
| `VaultWithdraw` | `app/earn/page.js` | A lender redeems shares for assets, capped at `AssetsAvailable`. Signed by the lender. |
| `VaultDelete` | `app/api/vault/route.js` (`close`) | Close the market. Requires an empty vault, otherwise `tecHAS_OBLIGATIONS`. |

## XLS-66 transactions used

Lending Protocol. All eight that the app needs; `LoanBrokerCoverClawback` is not used.

| Transaction | Where | Purpose |
|---|---|---|
| `LoanBrokerSet` | `app/api/vault/route.js` (`create`) | Create the broker over the vault with `ManagementFeeRate`, `DebtMaximum`, `CoverRateMinimum`, `CoverRateLiquidation`. |
| `LoanBrokerCoverDeposit` | `app/api/vault/route.js` (`cover`), `components/vaults/VaultManager.js` | Fund the junior first-loss layer. The desk mirrors a verified payment from the creator; a desk-owning operator can also submit it directly. |
| `LoanBrokerCoverWithdraw` | `app/api/vault/route.js` (`coverWithdraw`), `components/vaults/VaultManager.js` | Return cover, only ever to the creator recorded on the vault, and only above `CoverRateMinimum`. |
| `LoanSet` | `app/borrow/page.js`, `app/api/originate/route.js` | Dual-signed origination: the borrower signs in their wallet, the desk adds the `CounterpartySignature` server-side after underwriting. Carries `PrincipalRequested`, `InterestRate`, `PaymentInterval`, `PaymentTotal`, `GracePeriod`. |
| `LoanPay` | `app/borrow/page.js` | Pay an installment, or clear the loan with `tfLoanFullPayment`; `tfLoanLatePayment` when overdue. |
| `LoanManage` | `app/api/vault/route.js` (`loan`) | Impair a loan that looks bad (`tfLoanImpair`), undo it (`tfLoanUnimpair`), or default one past its grace period (`tfLoanDefault`), which liquidates cover into the vault. |
| `LoanDelete` | `app/api/vault/route.js` (`loanDelete`) | Remove a settled loan object so it stops holding a reserve. |
| `LoanBrokerDelete` | `app/api/vault/route.js` (`close`) | Close the broker. Succeeds while the vault still holds deposits, so it can orphan a vault: see Known issues. |

### Supporting amendments

| Standard | Transactions | Used for |
|---|---|---|
| XLS-33 (MPT) | `MPTokenIssuanceCreate`, `MPTokenAuthorize` | Mint a market's asset token; opt in to an asset or to vault shares. |
| XLS-70 / XLS-80 | `CredentialCreate`, `CredentialAccept`, `CredentialDelete`, `PermissionedDomainSet` | Gate a private vault's depositors; the market creator issues the credentials the domain accepts. |
| XLS-85 (TokenEscrow) | `EscrowCreate`, `EscrowFinish`, `EscrowCancel` | Borrower collateral held under a desk-derived crypto-condition, and share listings on the secondary market. |

## Layout

```
apps/web/
  app/            Earn, Borrow, Vaults, Activity, and the desk's API routes
  lib/            credit policy, underwriting, ledger reads, asset and money formatting
  components/     wallet, market selector, vault manager, share market, collateral
packages/
  lending-flows/  standalone scripts that verify each protocol behaviour on the devnet
```

`lib/credit.js` is pure policy with no network access, so the browser and the server compute
identical numbers from identical inputs. `lib/underwrite.js` gathers the ledger facts and hands
them to it.

## Known issues

- **Closing a market can orphan its vault.** `LoanBrokerDelete` succeeds even while the vault still
  holds deposits, and `VaultDelete` then fails with `tecHAS_OBLIGATIONS`. The broker is gone, the
  vault remains, and because discovery joins vaults to brokers the orphan stops being listed.
  Withdraw every deposit before closing.
- **Gated markets cannot list shares for sale.** A private vault's share MPT carries a `DomainID`,
  so the shares only move between domain members, and the desk holding the listing escrow is not
  one. Returns `tecNO_PERMISSION`.
- **Discovery only crawls the desk account.** A vault owned by any other account is found only by
  pasting its id into "Add by vault id" on the Vaults page.
