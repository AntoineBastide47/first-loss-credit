# Plan — First-Loss Institutional Credit (Track 1, Loaded)

XRPL Lending Protocol Hackathon. Track 1 (open-ended Single Asset Vault, merged XLS-65/66).
Use case: institutional term credit where a junior provider posts first-loss capital and
senior lenders are protected.

Six parts. Parts 1-5 are backend/protocol flows; Part 6 is the UI, independent of them and
**built in parallel** (see below).

| Part | Theme | Status |
|------|-------|--------|
| [part-1](part-1-vanilla-first-loss-credit/) | Vanilla: XLS-65 + XLS-66 core credit flow | **Implemented + verified live** (`impl/`, xrpl@5.2.0-beta.1) |
| [part-2](part-2-permissioned-domains-credentials/) | Loaded: Permissioned Domains + Credentials (gate depositors) | Verified vs merged spec + xrpl models |
| [part-3](part-3-mpts/) | Loaded: MPT-denominated vault and loan | Verified vs merged spec + xrpl models |
| [part-4](part-4-token-escrow-collateral/) | Loaded: TokenEscrow collateral (application-enforced) | Verified vs merged spec + xrpl models |
| [part-5](part-5-sponsored-fees-reserves/) | Loaded: sponsored fees/reserves | Mechanism UNVERIFIED |
| [part-6](part-6-ui/) | UI: browser consoles + risk monitor over the live devnet | Planned; independent of parts 1-5, parallelizable |

For parts 2-5, "Verified" means the transaction shapes and rules were checked against the merged
XLS specs and the xrpl.js models; live behavior is confirmed only where Part 1 exercised the same
primitive. Part 6 depends only on `lib/` and live reads, so it can proceed while the next backend
part is in progress; it surfaces live features and mocks not-yet-built ones behind a flag.

## Global conventions (every phase obeys these)

### Independence contract
Independent **phases**, not duplicated **code**. The two are separate:
- A **phase** is one numbered subsection (e.g. `1.3`). Each phase file is a complete,
  standalone runnable spec.
- **Phase independence** means a phase **does not reference any other phase and does not depend
  on a future phase**. It reads no other phase's runtime state and consumes no other phase's
  output. (Ex: phase 3 must not depend on phase 5; phase 4 need not know phases 1-3 exist.)
- A phase **builds the preconditions it needs** (accounts, assets, vault, broker, loan, escrow)
  by **composing the shared `lib/` builders** — never by copying another phase's code. Common
  setup is written **once** in `lib/` and called by every phase that needs it. Independent
  phases may share common code; they must not depend on one another.
- A `see 1.X` reference points to a **shared procedure realized in `lib/`**, not to another
  phase's runtime state or output. "Reproduce" means "call the shared builder", not "re-implement".
- Parts are also independent: no part imports another part; all depend only on `lib/`.
- The shared, non-phase `lib/` (below) and the SDK shapes here are the only common code —
  infrastructure, not a dependency on another phase's work.

### Shared `lib/` (not a phase)
Every phase may call these; none is phase-specific. Two modules:

**`lib/index.mjs` — generic XRPL primitives**
- `connect()` — open a client to the lending hackathon devnet WebSocket and assert the XLS-65/66
  amendments are enabled.
- `fundAccounts(n)` — create and fund `n` accounts (hackathon faucet), wait for validation.
- `submitAndWait(tx, wallet)` — autofill, sign, submit, wait for a **validated** ledger, return
  the metadata. `submitExpectingFailure` / `submitSignedExpectingFailure` — same but return the
  engine code without throwing (for guardrail negative controls).
- `waitLedgers(n)` / `waitUntilAfter(rippleTime)` — advance ledgers / wait past a ledger close
  time (timing tests).
- `roundUpToAssetUnit(value)` — round a high-precision loan figure **up** to the whole asset base
  unit (loan fields are already base-unit denominated; this is a ceil-to-integer).
- `readVault(vaultId)` / `readLedgerEntry(index)` — fetch the ledger object.
- `explorer(txHashOrAccount)` / `logFriction(entry)`.

**`lib/lending.mjs` — phase-agnostic protocol builders** (so no phase re-implements setup)
- `createVault(owner, opts)`, `vaultDeposit(lender, vaultId, amount)`,
  `createBroker(owner, vaultId, opts)`, `depositCover(owner, brokerId, amount)`.
- `signedLoanSet(...)` / `originateLoan(...)` — build the dual-signed LoanSet (borrower signs,
  owner counter-signs via xrpl.js `signLoanSetByCounterparty`) and optionally submit it.
- `createdIndex` / `createdFields` / `balanceChange` / `big` / `assert` / `makeRecorder` /
  `shareBalance` — shared metadata and run-log helpers.

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
- Use **`xrpl@5.2.0-beta.1`**: it adds the `counterparty` signing role so
  `signLoanSetByCounterparty` produces the `CPT`-prefix signature this build requires. (`5.1.0`
  has the Vault/Loan types but signs the counterparty signature with the wrong prefix.) Do not
  run against Mainnet.

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
- ✅ **LoanSet counterparty signing — use `xrpl@5.2.0-beta.1`.** This rippled verifies the
  counterparty signature with the `CPT` (`CounterpartyTxSign`) prefix. `xrpl@5.1.0`'s
  `signLoanSetByCounterparty` signed with the standard `STX` prefix and was rejected locally as
  "Counterparty: Invalid signature"; `5.2.0-beta.1` adds a `counterparty` signing role that uses
  the `CPT` prefix, so the SDK helper now works. `Account` (borrower) signs first, then
  `signLoanSetByCounterparty(owner, blob)` adds the `CounterpartySignature`. (`lib/lending.signedLoanSet`.)
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