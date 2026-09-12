---
name: building-on-lending-devnet
description: "Set up the environment to build on the XRPL Lending Protocol (XLS-65/66): Lending-Devnet endpoints, xrpl.js and xrpl-py versions, the accounts a lending flow needs, and the RLUSD network caveat. Use when configuring a client, choosing a library version, funding accounts, or wiring a vault/lending project to a network."
allowed-tools: Read Bash WebFetch
---

# Building on XRPL Lending-Devnet

The XLS-65/66 amendment is enabled on a dedicated **Lending-Devnet**, separate from the public
Devnet and Testnet. Point your client there before anything else; the commonest first-day failure
is building the whole flow against a network where the amendment is off.

## Networks

| Network | WebSocket | Use |
|---|---|---|
| **Lending-Devnet** | `wss://lend.devnet.rippletest.net:51233/` | XLS-65/66 vaults and loans. Build here. |
| Public Devnet | `wss://s.devnet.rippletest.net:51233/` | General devnet, no lending amendment. |
| Testnet | `wss://s.altnet.rippletest.net:51233/` | RLUSD test tokens live here (not on Devnet). |

Verify the amendment is actually live before coding: https://xrpl.org/resources/known-amendments
(the specs are still Draft status).

## Faucets
- Testnet: `https://faucet.altnet.rippletest.net/accounts`
- Public Devnet: `https://faucet.devnet.rippletest.net/accounts`
- **Lending-Devnet: no programmatic faucet host is documented.** Fund via the xrpl.org faucet
  web UI (select "Lending-Devnet") or test a host before scripting against it. Do not assume a
  `faucet.lend.devnet…` URL.

## Library versions (verified)
- **xrpl.js**: Vault (XLS-65) support from 4.4.0, Loan (XLS-66) from 4.5.0, `LoanSet`
  counterparty-signing helpers (`signLoanSetByCounterparty`, `combineLoanSetCounterpartySigners`)
  from 4.6.0. Latest 5.2.0. **Your scaffold's `xrpl@^5.1.0` already covers all of this** — no beta
  needed. Pin a known 5.x rather than a beta dist-tag.
- **xrpl-py**: Vault from 4.2.0, Loan from 4.4.0, counterparty helpers from 4.5.0. Latest stable
  5.1.0. Use ≥ 4.5.0 for the helpers.
- **xrpl-connect** (wallet adapter): your `^0.8.2` is current stable; a 1.0.0-rc exists.

## The RLUSD caveat
RLUSD test tokens are issued on **Testnet only** (issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`),
not on Lending-Devnet. A vault on Lending-Devnet cannot hold real RLUSD. Use XRP, an IOU you
issue, or an MPT you issue on Lending-Devnet as the vault asset; model RLUSD in the narrative.

## Accounts a first-loss institutional-credit flow needs
Fund these on Lending-Devnet (each needs XRP for reserves + fees):
1. **Asset issuer** — issues the IOU/MPT used as the vault asset (skip if using XRP).
2. **Lender(s)** — deposit into the vault, later withdraw + yield (the "senior" capital).
3. **Loan broker owner** — creates the `LoanBroker`, posts first-loss cover (the "junior" capital).
4. **Borrower** — counterparty on `LoanSet`, receives the drawdown, repays.

Reserves to budget: vault = 2 incremental reserves (vault + share issuance); loan broker = 2;
each loan = 1 (paid by the borrower).

## Reference app
Official Ripple reference for XLS-65/66 on XRPL:
https://github.com/ripple/xrpl-reference-app-lending-sav (live demo: https://lending.xls-demo.com/).
Read it for working transaction shapes when a field is unclear.

## Connecting (xrpl.js)
```js
import { Client } from "xrpl"
const client = new Client("wss://lend.devnet.rippletest.net:51233/")
await client.connect()
// submit VaultCreate / LoanBrokerSet / LoanSet etc.
```
The scaffold's network switcher defaults to AlphaNet — change it to Lending-Devnet for this work.
