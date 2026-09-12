---
name: xrpl-single-asset-vault
description: "Build and operate an XLS-65 Single Asset Vault on the XRP Ledger. Use when creating a vault, depositing or withdrawing, reading vault state (AssetsTotal, AssetsAvailable, shares), or computing the share/asset exchange rate for a lending pool. Covers VaultCreate, VaultDeposit, VaultWithdraw, VaultSet, VaultDelete, VaultClawback with xrpl.js 5.x."
allowed-tools: Read Bash WebFetch Grep Glob
---

# XRPL Single Asset Vault (XLS-65)

A Single Asset Vault pools one asset (XRP, an IOU, or an MPT) from many depositors and
issues each a share as an MPToken. A connected Lending Protocol (XLS-66) draws the pooled
asset out as loans and returns principal plus interest, so share value rises over time. This
skill is the vault half of a lending project; the loan half is in `xrpl-lending-protocol`.

Build against the **merged `master` spec**:
https://github.com/XRPLF/XRPL-Standards/blob/master/XLS-0065-single-asset-vault/README.md

## When to Use
- Creating the capital pool for a lending flow (lenders deposit, later withdraw + yield).
- Reading a vault's current value, available liquidity, or a depositor's position.
- Debugging why a deposit or withdrawal was rejected.

## When NOT to Use
- **The loan side** (broker, origination, repayment, default) — use `xrpl-lending-protocol`.
- **Picking a network or library version, funding accounts** — use `building-on-lending-devnet`.
- **Closed-ended / phased vaults** (Track 2). Those fields (`VaultKind`, `SubscriptionDate`,
  `RedemptionDate`) are **not in merged master**; they live in open draft PR #587. Do not code
  them as shipped without confirming the amendment is live on the event network.

## Transactions (merged master)

| Transaction | `tt` | Purpose |
|---|---|---|
| `VaultCreate` | 65 | Create the vault. Sets the asset and share terms. |
| `VaultSet` | 66 | Update mutable fields (`Data`, `AssetsMaximum`, `DomainID`). |
| `VaultDelete` | 67 | Delete an empty vault. |
| `VaultDeposit` | 68 | Assets in → shares minted to the depositor. |
| `VaultWithdraw` | 69 | Shares burned → assets out. `Amount` may be the asset **or** the share MPT. |
| `VaultClawback` | 70 | Issuer claws back a holder's position via their shares. |

### Key fields you will set
- `VaultCreate`: `Asset` (required — `XRP` / IOU / MPT), `Flags` (`tfVaultPrivate 0x00010000`,
  `tfVaultShareNonTransferable 0x00020000`), `AssetsMaximum` (0 = uncapped), `WithdrawalPolicy`,
  `DomainID` (permissioned-domain gate for a private vault), `Scale` (UINT8, default 6).
- `VaultDeposit`: `VaultID`, `Amount`.
- `VaultWithdraw`: `VaultID`, `Amount`, optional `Destination`, `DestinationTag`.
- `VaultClawback`: `VaultID`, `Holder`, `Amount` (0 = all of the holder's shares).

## Gotchas that cost the most time
- **`Scale` is forced to 0 for XRP and MPT assets** (0–18 only for IOU). Setting a non-zero
  `Scale` with an XRP or MPT asset is a silent footgun — share amounts will not be what you
  expect. See the reference for how `Scale` enters the share math.
- **There is no stored share price, no `utilisation`, no `accruedYield` field.** These are all
  derived. A UI that wants "current APY" or "utilisation" must compute them from `AssetsTotal`,
  `AssetsAvailable`, `LossUnrealized`, and outstanding shares. See
  [references/share-accounting-and-state.md](references/share-accounting-and-state.md).
- **Deposit and withdraw use different rates.** Deposit uses `AssetsTotal / SharesTotal`;
  redeem/withdraw uses `(AssetsTotal − LossUnrealized) / SharesTotal`. `LossUnrealized` (set by
  the loan side on impairment) makes withdrawals worth less than deposits imply — this is the
  mechanism, not a bug.
- **Rounding is down on deposit shares**, then assets are recomputed from the rounded shares,
  so the asset actually taken can be slightly less than requested.
- A vault create costs two incremental reserves (the `Vault` object and the share
  `MPTokenIssuance`).

## Reading vault state
Use the `vault_info` RPC (request field `vault` = the vault object ID). It returns the `Vault`
entry plus a nested `shares` object (the share `MPTokenIssuance`, whose `OutstandingAmount` is
`SharesTotal`). Field meanings and the exchange-rate formulas are in
[references/share-accounting-and-state.md](references/share-accounting-and-state.md).

## Verify before you trust a field name
xrpl.js 5.x ships the models (`vaultCreate.ts` … `vaultClawback.ts`). When a field name or flag
is unclear, read the spec section (link at top) rather than guessing — several `Invariants`
blocks in the spec are still `TBD`.
