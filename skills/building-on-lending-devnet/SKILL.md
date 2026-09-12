---
name: building-on-lending-devnet
description: "Set up the environment to build on the XRPL Lending Protocol (XLS-65/66): the Lending Hackathon devnet endpoints, faucet shape, xrpl.js and xrpl-py versions, a known counterparty-signing SDK bug, the accounts a lending flow needs, and the RLUSD network caveat. Use when configuring a client, choosing a library version, funding accounts, or wiring a vault/lending project to a network."
allowed-tools: Read Bash WebFetch
---

# Building on the XRPL Lending Hackathon devnet

The XLS-65/66 amendments run on a dedicated **Lending Hackathon devnet**. Point your client
there before anything else; the commonest first-day failure is building the whole flow against a
network where the amendment is off. Endpoints below were verified live on 2026-09-12
(`server_info`: build `3.4.0-rc1`, network id `4001`).

> The older `lend.devnet.rippletest.net` host in earlier docs does **not resolve** — do not use
> it. (Public Devnet `s.devnet.rippletest.net` happened to carry the amendments too on that date,
> but the hackathon devnet below is the supported target.)

## Networks

| Network | WebSocket | JSON-RPC | Use |
|---|---|---|---|
| **Lending Hackathon devnet** | `wss://lending-hackathon.dev.ripplex.io:51233` | `https://lending-hackathon.dev.ripplex.io:51234/` | XLS-65/66 vaults and loans. Build here. |
| Testnet | `wss://s.altnet.rippletest.net:51233` | — | RLUSD test tokens live here (not on the hackathon net). |

Explorer: `https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/`.

Amendments enabled (verified via the `feature` command): `SingleAssetVault`, `LendingProtocol`,
`LendingProtocolV1_1`, `PermissionedDomains`, `TokenEscrow` (+`fixTokenEscrowV1`), `MPTokensV1`,
`DynamicMPT`. Re-run `feature` to confirm before coding — the specs are still Draft.

Reserves on this network: **base 10 XRP, incremental 2 XRP** (higher than public Devnet). Budget
accordingly.

## Faucet (important: non-standard shape)
`https://lending-hackathon-faucet.dev.ripplex.io/accounts`

POST an empty JSON body. The faucet **generates and funds its own account** (about 1000 XRP) and
returns its secret; it **ignores any `destination`**, so `xrpl.js` `Client.fundWallet` fails here
with "faucet account is undefined". Fund by building a wallet from the returned secret:

```js
const res = await fetch("https://lending-hackathon-faucet.dev.ripplex.io/accounts", {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
const { account } = await res.json();          // { address, secret }, balance ~1000
const wallet = Wallet.fromSeed(account.secret); // then poll account_info until validated
```

## Library versions (verified)
- **xrpl.js**: Vault (XLS-65) from 4.4.0, Loan (XLS-66) from 4.5.0, `LoanSet` counterparty-signing
  helpers from 4.6.0. **Use `5.2.0-beta.1`** (dist-tag `beta-experimental`) for this devnet — it
  fixes the counterparty-signing prefix (below). `5.1.0`/`5.2.0` have the transaction types but
  sign the counterparty signature with the wrong prefix.
- **xrpl-py**: Vault from 4.2.0, Loan from 4.4.0, counterparty helpers from 4.5.0. Use ≥ 4.5.0.
- **xrpl-connect** (wallet adapter): `^0.8.2` is current stable; a 1.0.0-rc exists.

## LoanSet counterparty signing (fixed in xrpl.js 5.2.0-beta.1)
This rippled build verifies the LoanSet counterparty signature with a **distinct hash prefix
`CPT` (`HashPrefix::CounterpartyTxSign`)**, not the standard `STX`. `xrpl.js` ≤ 5.2.0 signed with
`STX`, so `signLoanSetByCounterparty` was rejected with local error "Counterparty: Invalid
signature". **`5.2.0-beta.1`** adds a `counterparty` signing role that uses the `CPT` prefix, so
the helper now works: the transaction `Account` signs first, then
`signLoanSetByCounterparty(counterpartyWallet, signedBlob)` adds the `CounterpartySignature`. On an
older xrpl.js the workaround is to re-sign `encodeForSigning(tx)` with the leading `53545800`
swapped for `43505400`.

## The RLUSD caveat
RLUSD test tokens are issued on **Testnet only** (issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`),
not on the hackathon devnet. A vault there cannot hold real RLUSD. Use XRP, an IOU you issue, or an
MPT you issue on the hackathon devnet as the vault asset; model RLUSD in the narrative.

## Accounts a first-loss institutional-credit flow needs
Fund these on the hackathon devnet (each needs XRP for reserves + fees):
1. **Asset issuer** — issues the IOU/MPT used as the vault asset (skip if using XRP).
2. **Lender(s)** — deposit into the vault, later withdraw + yield (the "senior" capital).
3. **Loan broker owner** — creates the `LoanBroker`, posts first-loss cover (the "junior" capital).
   This account must be the **vault owner**: `LoanBrokerSet` returns `tecNO_PERMISSION` for anyone
   who is not `Vault.Owner`.
4. **Borrower** — counterparty on `LoanSet`, receives the drawdown, repays.

Reserves to budget: vault = 2 incremental reserves (vault + share issuance); loan broker = 2;
each loan = 1 (paid by the borrower).

## Interest is cash-basis here (LendingProtocolV1_1)
Verified: interest is recognized on **payment**, not at origination. `Vault.AssetsTotal` does
**not** rise by interest due when `LoanSet` is submitted; it rises when `LoanPay` is received.
`AssetsAvailable` drops by the drawn principal at origination and returns (plus interest) on
repayment. Do not assert accrual-at-origination against this build.

## Reference app
Official Ripple reference for XLS-65/66 on XRPL:
https://github.com/ripple/xrpl-reference-app-lending-sav (live demo: https://lending.xls-demo.com/).
Read it for working transaction shapes when a field is unclear.

## Connecting (xrpl.js)
```js
import { Client } from "xrpl"
const client = new Client("wss://lending-hackathon.dev.ripplex.io:51233")
await client.connect()
// submit VaultCreate / LoanBrokerSet / LoanSet etc.
```
The scaffold's network switcher defaults to AlphaNet — change it to the hackathon devnet for this
work.
