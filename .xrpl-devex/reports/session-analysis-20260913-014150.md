# XRPL Session Analysis
**Participant:** young-zebra-47   **Team:** AAA   **Event:** btf-paris-2026-09
**Coverage:** full. The whole period is in the transcript and corroborated by 59 hook events (57 tool_result, 1 retry_resolved, 1 prompt). Every claim below about a result code comes from a transaction actually submitted to the hackathon devnet in this window.
**Features touched:** xls-65, xls-66, xls-70, xls-80, mpt
**What was attempted:** Consolidating a lending UI so the amendments are used inside the vault lifecycle rather than shown on separate screens, then making user-created vaults actually usable. That meant probing XLS-66 ownership rules directly: who may co-sign a loan, who may fund first-loss cover, whether broker terms can be edited, whether a permissioned domain can be repointed, and how to discover vaults at all. Several probes changed the design.

## Top 3 friction points
1. **`LoanBrokerSet` is create-only, and says so only by doing the wrong thing silently (protocol, xls-66).** Resubmitting it for the same `VaultID` with new terms does not update the broker: it creates a **second** `LoanBroker` (metadata showed 1 created, 0 modified) and leaves the original untouched. Passing `LoanBrokerID` to target the existing object is rejected `temINVALID`. So broker economics (management fee, minimum cover, liquidation rate) are immutable after creation, and a "Set" transaction that only ever creates is the opposite of the naming convention elsewhere on the ledger. An edit feature was built against the natural assumption and then deleted; the silent duplicate is worse than an error, because a broker holding cover would be orphaned.
2. **Owner coupling makes a wallet-owned vault structurally unable to lend (protocol, xls-66).** The broker owner must be the vault owner, and that single account is the only one that can (a) attach the `LoanSet` `CounterpartySignature` and (b) deposit first-loss cover, confirmed by a non-owner deposit returning `tecNO_PERMISSION`. The counterparty signature also needs the CPT signing prefix, which no browser wallet exposes, only a raw key. Net effect: any vault owned by an end user's wallet can never originate a loan from a web app. This forced a re-architecture where a server-held desk account owns the vault and broker while the creator configures and funds it.
3. **`tecNO_AUTH` covers three different causes with no way to tell them apart (protocol, xls-65/70).** A gated `VaultDeposit` returns the same code when the depositor has no credential, has a credential that has not been accepted, or has one from an issuer the domain does not trust. All three occurred here. Verbatim from the developer: *"what the fuck does Failed to sign transaction. Transaction failed on ledger: tecNO_AUTH mean ?"*. Resolving it needed three separate on-ledger probes to isolate the actual cause (a domain trusting a different issuer).

## Documentation gaps
- "what the fuck does Failed to sign transaction. Transaction failed on ledger: tecNO_AUTH mean ?" (xls-65). Nothing distinguishes missing, unaccepted, and untrusted-issuer credentials.
- No documented way to update broker terms, nor a statement that they are immutable. The failure mode is a silent duplicate object.
- No documented index from a vault to its broker, or any way to enumerate lending markets. Building a market directory required joining `account_objects type=vault` with `account_objects type=loan_broker` per owner and matching on `VaultID`.

## Wrong assumptions
- That `LoanBrokerSet`, like other `*Set` transactions, updates in place. It creates.
- That `WithdrawalPolicy: 0` was a sensible default. The enum starts at 1 (`vaultStrategyFirstComeFirstServe`), and 0 is malformed rather than defaulted.
- That issuing a credential grants access. `CredentialCreate` only offers it; the subject must `CredentialAccept` before a gate opens.

## Error messages worth improving
| result code | actual mistake | pointed at cause (1-5) |
|---|---|---|
| `temMALFORMED` | `VaultCreate` with `WithdrawalPolicy: 0`; valid values start at 1. The error names no field. | 1 |
| `temINVALID` | `LoanBrokerSet` with `LoanBrokerID`, trying to update an existing broker. No hint that updating is unsupported. | 2 |
| `tecNO_AUTH` | Gated `VaultDeposit` where the credential was missing, unaccepted, or from an untrusted issuer. One code, three causes. | 2 |
| `tecNO_PERMISSION` | `LoanBrokerCoverDeposit` submitted by a non-owner. Clear once you know cover is owner-only. | 4 |

## Abandoned
- Editing broker terms after vault creation. Blocked at `LoanBrokerSet`: resubmission creates a duplicate broker, and `LoanBrokerID` is rejected `temINVALID`. The UI now shows the terms read-only.

## Workarounds
- Desk-owned vault provisioning: a server-held account creates the vault and broker so loans can be co-signed, while the creator funds cover by paying the desk, with the validated payment verified before the deposit. Should be provided by the protocol (delegated counterparty signing, or letting a non-owner fund cover).
- Market discovery by joining `account_objects type=vault` and `type=loan_broker` on `VaultID`, because no vault-to-broker index exists. Should be provided by the protocol or an API.
- Repointing a permissioned domain to a new issuer to repair vaults whose gate trusted the wrong account.

## Timeline
`VaultCreate` reached first success in 2 attempts over 26 seconds (source: hook `retry_resolved`), the failure being `WithdrawalPolicy: 0`. Everything else in this window succeeded first time: `PermissionedDomainSet` (3, including an in-place update), `CredentialCreate` (5), `CredentialAccept` (2), `LoanSet` (1), `EscrowCancel` (1). `LoanBrokerSet` ran 4 times with 1 failure (`temINVALID`), `LoanBrokerCoverDeposit` twice with 1 failure (`tecNO_PERMISSION`); both failures were deliberate negative controls. Source: hook, corroborated by transcript.

## Not observed
- Whether broker terms can be changed by any mechanism at all; only `LoanBrokerSet` was tried, with and without `LoanBrokerID`.
- Whether a full ledger-wide vault enumeration is practical. `ledger_data` accepts `type: "vault"` but returned a marker immediately, so only per-owner enumeration was measured.
- Whether any browser wallet can produce a CPT-prefixed counterparty signature; concluded from the signing scheme, not tested against each adapter.
- Whether the developer worked in other Claude sessions or tools during the period (checkpoint mode does not ask).
