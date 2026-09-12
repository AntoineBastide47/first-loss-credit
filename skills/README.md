# XRPL Lending Skills

Claude skills for building an XRPL Lending Protocol project (XLS-65 Single Asset Vault +
XLS-66 Lending Protocol). Scoped to the hackathon **Track 1** project *first-loss institutional
credit*: a junior provider posts first-loss cover, senior lenders are protected, and the flow
exercises impairment → default → recovery.

All protocol facts are grounded in the merged `master` XLS-65/66 specs. Track 2 / "V1.1"
features (closed-ended vaults, cash-basis accounting, two-step `LoanAccept`) are flagged as
**open, unmerged PRs**, not shipped protocol.

| Skill | Use for |
|---|---|
| [building-on-lending-devnet](building-on-lending-devnet/SKILL.md) | Endpoints, library versions, account roles, RLUSD caveat. Start here. |
| [xrpl-single-asset-vault](xrpl-single-asset-vault/SKILL.md) | XLS-65 vault: create, deposit, withdraw, read state, share/asset math. |
| [xrpl-lending-protocol](xrpl-lending-protocol/SKILL.md) | XLS-66: loan broker, first-loss cover, dual-signed `LoanSet`, `LoanPay`, impair/default, Loaded primitives. |
| [xrpl-dev](xrpl-dev/SKILL.md) | General XRPL dev: `xrpl.js`, wallet connection, TrustLines/MPTs, NFTs, DEX/AMM, payments, Axelar/EVM interop, security. From [XRPL-Commons/xrpl-dev-skills](https://github.com/XRPL-Commons/xrpl-dev-skills). |

These are standalone skill directories (`<name>/SKILL.md` + `references/`), the same structure
Claude Code loads from `.claude/skills/`.
