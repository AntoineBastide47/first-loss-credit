# Plan — First-Loss Institutional Credit (Track 1, Loaded)

XRPL Lending Protocol Hackathon. Track 1 (open-ended Single Asset Vault, merged XLS-65/66).
Use case: institutional term credit where a junior provider posts first-loss capital and
senior lenders are protected.

Five parts:

| Part | Theme | Status |
|------|-------|--------|
| [part-1](part-1-vanilla-first-loss-credit/) | Vanilla: XLS-65 + XLS-66 core credit flow | Verified vs merged spec + xrpl@5.1.0 |
| [part-2](part-2-permissioned-domains-credentials/) | Loaded: Permissioned Domains + Credentials (gate depositors) | Verified vs merged spec + xrpl@5.1.0 |
| [part-3](part-3-mpts/) | Loaded: MPT-denominated vault and loan | Verified vs merged spec + xrpl@5.1.0 |
| [part-4](part-4-token-escrow-collateral/) | Loaded: TokenEscrow collateral (application-enforced) | Verified vs merged spec + xrpl@5.1.0 |
| [part-5](part-5-sponsored-fees-reserves/) | Loaded: sponsored fees/reserves | Mechanism UNVERIFIED |

Status means the transaction shapes and rules were checked against the merged XLS specs and
the installed `xrpl@5.1.0` models. Live behavior is **not** verified (see endpoint caveat).

## Global conventions (every phase obeys these)

### Independence contract
- A **phase** is one numbered subsection (e.g. `1.3`). Each phase file is a complete,
  standalone runnable spec.
- A phase **builds every precondition it needs** (accounts, assets, vault, broker, loan,
  escrow) and **reads no other phase's runtime state**. No phase consumes another phase's
  output.
- A `see 1.X` / `inline as in 3.1` reference points to a **documented procedure to
  reproduce**, never to another phase's runtime state or output. Reproduce the steps locally.
- Parts are also independent: Part 4 does not import Parts 1-3.
- The **only** shared code is a non-phase `lib/` (below) and the SDK shapes here. A library
  and a shared reference are infrastructure, not a dependency on another phase's work.

### Shared `lib/` (not a phase)
Every phase may call these helpers; none is phase-specific:
- `connect()` — open a client to the lending hackathon devnet WebSocket and assert the XLS-65/66
  amendments are enabled.
- `fundAccounts(n)` — create and fund `n` accounts, wait for validation.
- `submitAndWait(tx, wallet, extraSigners?)` — autofill, sign, submit, wait for a
  **validated** ledger, return the metadata.
- `waitLedgers(n)` — advance `n` validated ledgers (timing tests).
- `roundUpToAssetUnit(value, asset)` — round a high-precision loan figure **up** to the
  asset base unit (drops for XRP, `10^-AssetScale` for MPT).
- `readVault(vaultId)` / `readLoanBroker(id)` / `readLoan(id)` — fetch the ledger object.
- `explorer(txHashOrAccount)` — return an explorer URL for the run log.
- `logFriction(entry)` — append a structured note for the DevEx report.

### Endpoint (verified live 2026-09-12)
- **WebSocket:** `wss://lending-hackathon.dev.ripplex.io:51233` (build `3.4.0-rc1`, network
  `4001`). JSON-RPC `https://lending-hackathon.dev.ripplex.io:51234/`.
- **Faucet:** `https://lending-hackathon-faucet.dev.ripplex.io/accounts`. POST an empty body;
  it returns `{ account: { address, secret }, balance }` for a **new** account it funds
  (~1000 XRP) and **ignores `destination`**, so `Client.fundWallet` does not work — build a
  wallet from the returned secret. Reserves: base **10 XRP**, incremental **2 XRP**.
- **Explorer:** `https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233/`.
- Amendments enabled: `SingleAssetVault`, `LendingProtocol`, `LendingProtocolV1_1`,
  `PermissionedDomains`, `TokenEscrow`, `MPTokensV1`, `DynamicMPT`. The old
  `lend.devnet.rippletest.net` host does not resolve; do not use it.
- `xrpl` resolves to `5.1.0` locally; Vault (4.4.0+) and Loan (4.5.0+) types are present, but
  `signLoanSetByCounterparty` is **broken** against this build (wrong signing prefix — see
  SDK shapes). Do not run against Mainnet.

### Cross-cutting protocol rules
- **Interest is cash-basis on this build (`LendingProtocolV1_1`), verified in 1.1.** At
  `LoanSet` (origination) `Vault.AssetsAvailable` drops by the drawn principal and
  `Vault.AssetsTotal` is **unchanged** (no accrual). Interest is recognized when `LoanPay` is
  received: `AssetsTotal` and `AssetsAvailable` both rise by the interest paid. Share price is
  derived, never stored. (The earlier "accrual at origination" assumption was wrong here.)
- **No stored `utilisation`, `sharePrice`, or `accruedYield`.** Derive from `AssetsTotal`,
  `AssetsAvailable`, `LossUnrealized`, and outstanding shares.
- **Loan fields hold high-precision decimals already in the asset base unit** (e.g.
  `PeriodicPayment` = `"20000038.05..."` drops for an XRP vault). Never assume integers. Round a
  payment **up to the next whole base unit** (ceil to integer) — the value is not re-scaled.
- **Timing:** impair only after `NextPaymentDueDate`; default only one validated ledger
  **strictly beyond** `NextPaymentDueDate + GracePeriod`.
- For each guardrail rejection, make all **other** preconditions pass so the failing reason
  is unambiguous.

### SDK shapes (xrpl@5.1.0; ✅ = verified live on the hackathon devnet in 1.1)
- ✅ **Vault owner = broker owner.** Only `Vault.Owner` can `LoanBrokerSet`; any other account
  gets `tecNO_PERMISSION`. The account that creates the vault must create the broker.
- ✅ **LoanSet counterparty signing — `signLoanSetByCounterparty` is broken here.** It signs with
  the standard `STX` prefix, but this rippled verifies the counterparty signature with the
  `CPT` (`CounterpartyTxSign`) prefix, so it is rejected locally as "Counterparty: Invalid
  signature". Work around it: `Account` signs first, then take `encodeForSigning(tx)`, replace
  the leading `53545800` with `43505400`, sign with the counterparty key, and set
  `CounterpartySignature = { SigningPubKey, TxnSignature }`. (`lib/signLoanSetCounterparty`.)
- ✅ **VaultWithdraw `Amount` selects what you redeem.** A bare asset amount (XRP drops) withdraws
  that many **assets** and leaves yield behind. To redeem **all shares** and receive their full
  value, pass the **share MPT** amount `{ mpt_issuance_id: ShareMPTID, value: shares }`.
- ✅ **Vault XRP asset:** `Asset: { currency: "XRP" }`. The bare string `"XRP"` fails validation.
- **Vault MPT asset:** `Asset: { mpt_issuance_id }` with **no `value`**. Deposit/withdraw
  `Amount` fields **do** carry `value`. **Omit `Scale`** for MPT/XRP vaults (do not send `0`);
  it reads back as `0`. An explicit `Scale` on an MPT asset is rejected at client-side
  validation (no tx hash).
- **`LoanSet.PrincipalRequested`** is an XRPLNumber **string** (e.g. `"1000"`). Only
  `LoanPay.Amount` uses `{ mpt_issuance_id, value }`.
- **`PermissionedDomainSet.AcceptedCredentials`:** `[{ Credential: { Issuer, CredentialType } }]`.
  The flat `{ Issuer, CredentialType }` form fails validation.
- **Do not rely on a `Loan.Data` field.** `LoanSet.Data` is a valid **transaction** blob
  (≤256 B). Whether it persists on the `Loan` **ledger object** was disputed by two
  independent checks, so treat the escrow↔loan mapping as **off-ledger**: keep it in
  application state, recover it from `LoanSet.Data` in transaction history, or use
  transaction **memos**. Confirm the `Loan` entry's field list in the xrpl.js ledger model
  before assuming persistence.
- **`EscrowFinish`** uses `Owner` + `OfferSequence` (no ledger-ID-only form); **any** account
  may submit; a crypto-`Condition` controls release. **IOU** escrow needs the issuer account
  flag `asfAllowTrustLineLocking` (`AccountSet`), not a trust-line flag. **MPT** escrow
  between non-issuers needs **both** `tfMPTCanEscrow` and `tfMPTCanTransfer`.
- **Rate units:** `ManagementFeeRate` range **0-10000**; cover rates (`CoverRateMinimum`,
  `CoverRateLiquidation`) range **0-100000**; interest rates annualized in 1/10 bps.

### Per-phase file shape
Objective → Independence contract → Preconditions this phase builds → Actors → Transaction
steps (exact fields) → Expected results and assertions → Explorer verification →
Precision/timing rules → Friction to capture → xrpl.js references → XLS references.


## Other info

Notion: https://holly-pixie-8e9.notion.site/XRPL-Lending-Protocol-Hackathon-3152f6835886823ab31f01cd9d1f6ded