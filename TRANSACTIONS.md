# Verified on-chain transactions

Every transaction below was submitted by this project against the hackathon devnet and read
back from a validated ledger with `tesSUCCESS`. Each link opens the transaction in the
explorer.

**Network:** Lending Hackathon Devnet, `wss://lending-hackathon.dev.ripplex.io:51233`,
network id 4001, rippled 3.4.0-rc1.
**Explorer:** `https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233`

## XLS-65, Single Asset Vault

| Transaction | Ledger | Receipt |
|---|---|---|
| `VaultCreate` | 90952 | [64264FB4…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/64264FB46F9356633BD9AD9402542E083BC1EF32129F1EEB431BFED90110E7B6) |
| `VaultSet` | 79576 | [784179DC…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/784179DCB10F5A57D4FAF96966DAE591EE60BD178E045CE0920A3EF75BB87FDF) |
| `VaultDeposit` | 90473 | [811AB096…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/811AB096AB30462EBE57E9A11D37856B669CEB960B76F900C2DFF89746F46986) |
| `VaultWithdraw` | 90772 | [8E70C312…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/8E70C3122C6A33349B2C829B76F81E8FF5EE928DAED8D48AE9940FA0EEABB343) |
| `VaultDelete` | 90903 | [E9D9A1CD…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/E9D9A1CDD88341471F4B263CA85A23441B323F09A23B0B1BFF0455ED43CFDC8C) |

`VaultCreate` at 90952 is the Meridian XRP Credit Fund, one of the two demo markets the app
ships with. `VaultDelete` at 90903 closed an emptied market.

## XLS-66, Lending Protocol

| Transaction | Ledger | Receipt |
|---|---|---|
| `LoanBrokerSet` | 90954 | [9CF3005F…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/9CF3005F8E70D263D0BD58E86FDBABA4663BDFFAF8AD69708CAE8AF1EE4520D9) |
| `LoanBrokerCoverDeposit` | 90693 | [8C7F898E…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/8C7F898EF17398A8EABEF64A56ED874FB98EE3EABC8F71A16DB0920FAB60FB92) |
| `LoanBrokerCoverWithdraw` | 91179 | [0862A57E…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/0862A57ECD57ABC79B0895B1A0918F88D00C12678010012D367422DB58270E83) |
| `LoanSet` | 90056 | [7469C3DA…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/7469C3DABE9252CDB246C6421B3D7D57F5EADCC9DD3FA7F0562F69C8130228ED) |
| `LoanPay` | 90058 | [E9B76919…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/E9B76919D4B7275BFE8C6E834D3035D4700DC732ADC37944E026CF69C582C3CC) |
| `LoanManage` (default) | 91123 | [1B1257F6…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/1B1257F65CFBD343DCDA31ECC79740BAC075B76C1BF9C0A13A1E50A4D4598AAE) |
| `LoanDelete` | 91165 | [3F40AE7A…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/3F40AE7AFF50101929FF840F837DA9F615DAE0AEE997DB4E481B3ACB18C5D28E) |
| `LoanBrokerDelete` | 91180 | [868AC41A…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/868AC41A70B0591A6438C62AFD5BF8F2C9FFD7085DD7B522B6A1B70F044F7E31) |

`LoanSet` at 90056 is a dual-signed origination: the borrower signed in their wallet and the
desk added the `CounterpartySignature` after underwriting the request. `LoanManage` at 91123
carries `tfLoanDefault`, which liquidated the broker's first-loss cover into the vault.

## Supporting standards

| Standard | Transaction | Ledger | Receipt |
|---|---|---|---|
| XLS-33 | `MPTokenIssuanceCreate` | 75965 | [BB945196…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/BB945196BE9BF810980961A39DB4C80B46AFEA6C0546617101538D4F853CE854) |
| XLS-33 | `MPTokenAuthorize` | 75967 | [0BF87ACC…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/0BF87ACCF2E2EFE4FBB64B4297788843F4A16DE21F1208CDDC5D994FA137C690) |
| XLS-70 | `CredentialCreate` | 78637 | [13391C58…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/13391C58A16EB92D9FD27D60BCCCB391DE3E932B28B4F72D4018B984F03FD4B4) |
| XLS-80 | `PermissionedDomainSet` | 78851 | [146BF92E…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/146BF92ED15CED923EBE384D5C0F1DEC9F0ED17147DC05931C0EC376529B944F) |
| XLS-85 | `EscrowCreate` | 90475 | [FC4911BB…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/FC4911BB61368464A33F8DD308970F26E8554D24A25EA05121B0ED40BB0B0627) |
| XLS-85 | `EscrowFinish` | 90570 | [10FC1E89…](https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/transactions/10FC1E899F52434DF8FA907740E29EFEE5A8F97FD29A8F8677A19836789FFA8C) |

The XLS-85 pair above is one share listing being sold on the secondary market: the seller
escrowed vault shares to the desk with the asking price in the escrow's `DestinationTag`, the
buyer paid the seller directly, and the desk released the shares once it had verified that
payment on the ledger.

## Not captured here

`CredentialAccept`, `CredentialDelete` and `EscrowCancel` are all used by the app and exercised
by the flows in `packages/lending-flows`, but no successful instance was found in the account
histories searched for this index, so no receipt is listed rather than an unverified one.

`VaultClawback` and `LoanBrokerCoverClawback` are not used by this project.

## Reproducing

Each script in `packages/lending-flows/src` builds its own vault, broker, lender and borrower
and prints an explorer link per transaction, so a fresh set of receipts can be generated at any
time:

```bash
cd packages/lending-flows
node src/loan/origination-and-repayment.mjs
node src/loan/impairment-default-recovery.mjs
```
