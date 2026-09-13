# Agent review

An honest account of what the agent built on this project, what is actually verified, what
is broken, and where the agent got things wrong. The companion document,
`.xrpl-devex/reports/`, reviews the protocol. This one reviews the work.

## What was built

A first-loss credit market on XLS-65 and XLS-66: lenders deposit into a vault, borrowers
draw from a loan broker, junior cover absorbs defaults before senior lenders. On top of the
protocol surface the agent added three things that are not thin wrappers over the API:

- **Underwriting and risk-based pricing.** `lib/credit.js` is pure policy with no network
  access, so the browser and the server compute identical numbers. `/api/quote` prices and
  sizes a loan from ledger facts alone: repayment record, collateral escrowed to the desk,
  credential held, pool utilisation, chosen term. `/api/originate` re-derives the same
  decision when the signed loan arrives, so the quote is a preview and never a promise the
  server has to store.
- **Loan terms.** Nine terms from one day to five years, six payment counts, priced with a
  concave term premium and a pool-level duration budget.
- **A secondary market for vault shares**, because the DEX cannot quote MPTs.

## What is verified, and how

Verification here means re-queried from the devnet, not recalled.

| Claim | Evidence |
|---|---|
| Every offered loan option enforces its own rate floor and principal cap | 54 of 54 options tested individually, 0 failures |
| A quote survives to the ledger unchanged | End to end origination: ledger carried `InterestRate 10393`, `PaymentInterval 2628000`, matching the quote exactly |
| The duration budget reads the live loan book | Exposure rose by exactly the principal drawn, returned to zero on repayment |
| Share listings settle correctly | Full sale on devnet: shares moved seller to buyer, replay refused, underpayment refused, untagged payment refused |
| Every transaction type in the README | 19 receipts re-queried: hash resolves, type matches, `tesSUCCESS`, validated. See `TRANSACTIONS.md` |
| Collateral is judged per term | A two day escrow backed one day loans and was correctly ignored for one week and longer |

## Known defects

These are real and unfixed. They are listed because a submission that hides them is worth
less than one that does not.

1. **The share market does not work on gated vaults.** A private vault's share token carries
   a `DomainID`, so shares only move between domain members, and the custodian holding the
   listing escrow is deliberately not one. Returns `tecNO_PERMISSION`. This is a design
   error, not a bug: the agent routed every listing through a custodian without checking
   that the custodian could legally hold the asset.
2. **Closing a market can orphan its vault.** `LoanBrokerDelete` succeeds while the vault
   still holds deposits, `VaultDelete` then fails with `tecHAS_OBLIGATIONS`, and because
   discovery joins vaults to brokers the orphan stops being listed at all.
3. **Three vaults cannot be wound down.** They hold deposits from accounts whose keys nobody
   has, and `VaultClawback` is refused because the underlying asset must permit clawback:
   XRP never does, and the MPT was minted without `tfMPTCanClawback`. Depositor funds are
   intact and withdrawable, but the vaults are permanent.
4. **Discovery only crawls the desk account.** A vault owned by anyone else is reachable
   only by pasting its id.

## Where the agent got it wrong

**Acting before establishing feasibility.** The worst failure of the session. Asked to hard
delete every vault, the agent ran a teardown that defaulted a loan, withdrew cover from two
brokers and deleted two brokers, and only then discovered that `VaultClawback` could never
have worked because neither asset permits clawback. One flag read, which took ten seconds
afterwards, would have shown the whole operation was impossible before anything was
destroyed. The correct order is: establish that the end state is reachable, then act.

**Applying a portfolio constraint per loan.** The duration cap limited each individual loan
rather than the pool's total long-dated exposure. It therefore failed at its own purpose,
since fifty borrowers could still freeze the pool between them, while making a 100 XRP
market quote a maximum 2 XRP five-year loan. The developer caught it with "why can I draw so
little", not the agent.

**Creating a parsing bug and then not recognising it.** The desk wrote `DebtMaximum` as
`"1000000000000"`. The ledger returns that as `"1e12"`, which `BigInt` rejects. Seven markets
broke, and it surfaced as an apparently unrelated missing UI feature. The agent chose the
constant and did not consider how the value would read back.

**Declaring a fix done from the wrong evidence.** The overflowing stat card was reported
fixed on the basis of what the server was sending, when the fix only just fit and the
developer was looking at a stale page. Server state is not the user's view.

**Scope discipline, early.** The developer pushed back hard on half-built screens added
without being asked, and on standalone pages that demonstrated amendments rather than using
them inside a real flow. That feedback was correct and the work was better after it.

## Where the process worked

**Diagnosing from the ledger rather than guessing.** When a `tecNO_PERMISSION` could not be
explained, the agent scanned recent ledgers, found the developer's exact failing transaction,
and read its metadata, rather than asking them to hunt for a hash.

**Refusing to invent a cause.** One failure at ledger 90406 could not be reproduced: every
ledger-side explanation was checked at that exact ledger and eliminated, and the identical
transaction later simulated successfully. It is recorded as undetermined. A plausible
sounding guess would have been worse than nothing.

**Verifying claims against the source.** Every transaction reference in `README.md` was
cross-checked against the code, and every hash in `TRANSACTIONS.md` re-queried before being
written as a link. Three transaction types are listed as not captured rather than given an
unverified receipt.

**Respecting a blocked action.** When the sandbox refused a command that would read the
operator seed and move depositor funds, the agent stopped and explained rather than looking
for a way around it.

## What to fix next, in order

1. Check emptiness before deleting a broker, and add a way to delete a brokerless vault.
   Without the second part the existing orphans stay unreachable.
2. Named-buyer escrow for gated markets, so the custodian never holds gated shares and the
   compliance domain stays intact.
3. Pre-flight transactions with `simulate` before asking a wallet to sign, so an opaque
   `tec` code becomes a sentence before the signature rather than after it.
4. Widen discovery beyond the desk account, or make the market id a first-class shareable
   object.

## Honest summary

The underwriting, pricing and term work is the strongest part and is well verified. The
secondary market works on open markets and is broken on gated ones. The operational side,
closing and deleting markets, is the weakest and has left permanent residue on the devnet.
The agent's recurring failure mode was acting on a plan before confirming the plan could
finish, and its most useful habit was refusing to state anything it had not checked.
