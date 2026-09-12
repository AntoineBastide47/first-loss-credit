# Share accounting and reading vault state (XLS-65)

Source: XLS-65 master §3.1.2, §3.1.7, §3.9.
https://github.com/XRPLF/XRPL-Standards/blob/master/XLS-0065-single-asset-vault/README.md

## Vault fields that matter

| Field | Meaning |
|---|---|
| `AssetsTotal` | Total value of the vault, including asset lent out and interest booked. |
| `AssetsAvailable` | Assets free to withdraw now. A live loan lowers this while `AssetsTotal` still counts the outstanding debt + interest. |
| `LossUnrealized` | Paper loss set by the loan side on impairment. Lowers redemption value. |
| `AssetsMaximum` | Deposit cap (0 = none). |
| `ShareMPTID` | The share `MPTokenIssuance` id. |
| `Scale` | Share/asset scaling exponent (10^Scale). Forced 0 for XRP and MPT. |

**Utilisation is not a field.** Compute it: `1 − AssetsAvailable / AssetsTotal`.
**Share price is not a field.** Compute it from the formulas below.
**Accrued yield is not a field.** It is implicit in a rising `AssetsTotal / SharesTotal`.

`SharesTotal` = `MPTokenIssuance(ShareMPTID).OutstandingAmount`. In `vault_info` it is
`vault.shares.OutstandingAmount`.

## Exchange-rate formulas (§3.1.7.1)

- Deposit rate (assets → shares): `AssetsTotal / SharesTotal`.
- Redeem/withdraw rate (shares → assets): `(AssetsTotal − LossUnrealized) / SharesTotal`.

The two rates differ by `LossUnrealized`. With no impairment they are equal.

## Mint / burn math (§3.1.7.2)

- **First deposit into an empty vault:** `Δshares = Δassets × 10^Scale`.
- **Later deposit:** `Δshares = floor(Δassets × SharesTotal / AssetsTotal)`, then the asset
  actually taken is recomputed from that rounded share count (so it can be slightly below the
  requested amount).
- **Redeem (burn N shares):** `Δassets = N × (AssetsTotal − LossUnrealized) / SharesTotal`.
- **Withdraw (request asset amount A):** convert to shares
  `Δshares = A × SharesTotal / (AssetsTotal − LossUnrealized)`, round to nearest, then pay out
  with the redeem formula.
- **Sole shareholder exception:** `LossUnrealized` is waived, so the holder can withdraw the
  full `AssetsTotal`.

## Reading it from a client

Request the `vault_info` method with `vault` set to the vault object id. The response carries
the `Vault` entry and a nested `shares` object (the share issuance). Everything above is derived
from those two objects — do not expect the node to return a price or APY.
