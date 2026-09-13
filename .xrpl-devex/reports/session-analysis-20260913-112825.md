# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** AAA   **Event:** btf-paris-2026-09
**Coverage:** partial, checkpoint period 2026-09-13T07:27:12Z to 09:28:03Z. The live transcript for this window is in context and 205 hook events were matched for this session. One compaction happened inside the period, so the earliest turns are summarised rather than verbatim. Ledger evidence was read directly from the hackathon devnet, so transaction level claims are checked against the chain rather than recalled.
**Features touched:** xls-65, xls-66, xls-85, xls-70, xls-80, mpt
**What was attempted:** Building underwriting, risk based pricing and borrower assessment on top of XLS-66, then extending loan terms from hours to five years, then a secondary market for XLS-65 vault shares so lenders can exit when the pool is fully lent. The last hour was spent diagnosing a `tecNO_PERMISSION` on escrowing vault shares.

## Top 3 friction points

**1. XRPLNumber fields round trip in scientific notation and break `BigInt`.** A loan broker was created with `DebtMaximum: "1000000000000"`. The ledger returns it as `"1e12"`. `BigInt("1e12")` throws `SyntaxError: Cannot convert 1e12 to a BigInt`, and splitting on `"."` yields nonsense. Seven of the nine broker objects owned by the desk account carried `"1e12"`; the two created with 1e9 stayed in plain notation, so the bug looked market specific rather than numeric. It surfaced to the developer as a missing UI feature ("why do user created vaults not have the repayment duration option") because the quote endpoint threw before rendering. Every high precision field is exposed to this: `DebtMaximum`, `DebtTotal`, `CoverAvailable`, `PrincipalOutstanding`, `PeriodicPayment`, `TotalValueOutstanding`. Roughly 25 minutes, and it would have been far longer without a full enumeration of broker objects.

**2. `tecNO_PERMISSION` on `EscrowCreate` for permissioned MPT shares, with no documented cause.** A private XLS-65 vault issues its share MPT with `lsfMPTRequireAuth` and a `DomainID`. Escrowing those shares to an account that is not a member of that domain returns `tecNO_PERMISSION`. [XLS-0085](https://xls.xrpl.org/xls/XLS-0085-token-escrow.html) lists exactly three causes for that code on an MPT escrow: source is the issuer, missing `lsfMPTCanEscrow`, missing `lsfMPTCanTransfer`. None of them covers the permissioned domain case, so the spec text sends you looking at flags that are all set correctly (`Flags: 60` = CanTransfer + CanTrade + CanEscrow + RequireAuth). Confirmed on ledger 90180. Two attempts, about 40 minutes across the period, and it invalidated the design of the share market for every gated vault.

**3. The native DEX cannot quote MPTs, so there is no order book for vault shares.** `OfferCreate.TakerGets` and `TakerPays` are typed `Amount`, which in xrpl.js resolves to `IssuedCurrencyAmount | string` and excludes `MPTAmount`, while `Payment.Amount` and `EscrowCreate.Amount` both accept `Amount | MPTAmount`. Since XLS-65 vault shares are an MPT, the only way to build a secondary market was a bespoke escrow book with a custodian, which is what then collided with friction point 2. The share issuances carry `lsfMPTCanTrade` (flag 16), which reads as though trading is supported and is easy to misread as DEX support.

## Documentation gaps

Verbatim developer questions in the period:

- "Is 30 days the max ? Can there not be a 1, 2, 3, 4, 5 year loan ?" The bounds on an XLS-66 repayment schedule are not stated anywhere we could find. We determined empirically on the devnet that `PaymentInterval >= 60` seconds and `GracePeriod <= PaymentInterval` are enforced (xrpl.js `loanSet.js` also enforces `GracePeriod >= 60` in practice), and that there is no upper bound at all: a 100 year term with 1200 payments and a single payment due in 2031 were both accepted with `tesSUCCESS`. A one line statement of the bounds in the XLS-66 reference would have replaced a self contained probe.
- "Not submitted. Failed to sign transaction. Transaction failed on ledger: tecNO_PERMISSION. When I try to sell positions I get this error." See friction point 2. The XLS-85 failure list is incomplete for permissioned MPTs.

Also undocumented as far as we could tell: which XRPL number fields may be serialised in scientific notation, and the distinction between `tecNO_AUTH` and `tecNO_PERMISSION` on an MPT escrow (we established by experiment that a destination with no `MPToken` gives `tecNO_AUTH`, while a destination holding an authorised `MPToken` but outside the domain gives `tecNO_PERMISSION`).

## Wrong assumptions

- That a ledger value written as a plain integer string comes back as a plain integer string. It does not once it is large enough.
- That `lsfMPTCanEscrow` being set was sufficient for an MPT escrow to be permitted. Domain membership of the destination is also required and is not in the flag set.
- That `lsfMPTCanTrade` implied the token could be placed on the DEX.
- That a vault share MPT behaves like an ordinary MPT. The protocol managed issuance carries auth and domain constraints the holder never chose.

## Error messages worth improving

| result code | actual mistake | pointed at cause 1 to 5 |
|---|---|---|
| `tecNO_PERMISSION` (EscrowCreate) | escrow destination is not a member of the MPT's permissioned domain; undocumented cause | 1 |
| `tecNO_PERMISSION` (EscrowCreate, ledger 90406) | not reproducible; the identical transaction later simulated `tesSUCCESS` and three other accounts performed it successfully within minutes | 1 |
| `tecNO_PERMISSION` (MPTokenAuthorize) | an issuer opting in to its own issuance; verified by experiment | 2 |
| `tecNO_PERMISSION` (EscrowCancel) | cancelling before `CancelAfter`; verified by experiment | 2 |
| `tecNO_AUTH` (EscrowCreate) | destination holds no `MPToken` for a `RequireAuth` issuance | 3 |
| `tecINSUFFICIENT_FUNDS` (VaultWithdraw) | withdrawing more than `AssetsAvailable` while the rest is lent out | 3 |

`tecNO_PERMISSION` carried at least four distinct meanings in this period across three transaction types. It is the single least informative code we met.

## Abandoned

- Desk custodied listings for shares of gated vaults. Blocked at permissioned domain membership: the custodian cannot legitimately be admitted to every market's compliance domain, so the open order book design cannot cover gated markets. A named buyer escrow is the likely replacement, not yet built.

## Workarounds

- A `plainDecimal` / `baseUnits` pair that expands scientific notation before any money string is parsed or formatted. Belongs in the SDK as an XRPLNumber parser.
- A bespoke escrow based order book for vault shares, because the DEX cannot quote MPTs. Belongs in the protocol.
- Overriding `navigator.onLine` in the browser so WalletConnect will attempt its relay. The bundled WalletConnect gates 22 relay call sites, including the reconnect heartbeat, on that flag alone and throws "No internet connection detected. Please restart your network and try again." without making any request. The flag is unreliable after sleep or a VPN change. Belongs in the SDK.
- Enumerating the loan broker's pseudo account to read the loan book, since there is no index from a broker to its loans.

## Timeline

| transaction type | time to first success | source |
|---|---|---|
| EscrowCreate | resolved after 2 attempts, 202 seconds | hook |
| OfferCreate | resolved after 2 attempts, 2 seconds | hook |
| LoanSet | first attempt in period succeeded | transcript |
| VaultDeposit, LoanPay, Payment, MPTokenAuthorize | first attempt in period succeeded | transcript |

Ten `tesSUCCESS` and six `tecNO_PERMISSION` results were recorded by the hook in the period, with seven tool results marked failed.

## Not observed

- Root cause of the `tecNO_PERMISSION` at ledger 90406 on a public vault. Checked at that exact ledger: issuance flags 56 with no `DomainID`, holder balance 9999942 unlocked, destination `MPToken` present, both accounts `Flags: 0`, timings valid, metadata carrying only the fee deduction. The identical transaction simulates `tesSUCCESS` now and three fresh accounts performed it successfully at ledgers 90447, 90469 and 90475. Cause undetermined; not attributed to any protocol behaviour.
- A `tecNO_PERMISSION` on `LoanBrokerSet` was logged by the hook at 07:41:59Z. Its context was not identified in the transcript and no claim is made about it.
- Whether the developer worked in other Claude sessions or tools during the period. Checkpoint mode does not ask.
- Whether MPTs can be traded on the DEX on some other build. Only the xrpl.js 5.2.0-beta.1 type definitions and this devnet were checked.
