// Vault provisioning and owner actions, executed by the desk.
//
// Why the desk owns vaults created in the app: XLS-66 ties the broker owner to the vault
// owner, and that single account is the only one that can (a) attach the LoanSet
// CounterpartySignature and (b) deposit first-loss cover (a non-owner gets
// tecNO_PERMISSION). A browser wallet cannot produce a counterparty signature at all
// (it needs the CPT signing prefix), so a user-owned vault could never originate a loan.
// The desk therefore owns the ledger objects while the creator configures and funds the
// market, which keeps every created vault fully usable: lend, borrow, cover, default.
//
// The creator funds cover by paying the desk first; this route verifies that validated
// payment before depositing the same amount as cover, so the desk never funds it.

import { Client, Wallet, VaultWithdrawalPolicy, VaultCreateFlags, convertStringToHex } from "xrpl";
import { DEFAULT_NETWORK } from "../../../lib/networks";

export const runtime = "nodejs";

// Vault Data is capped at 256 bytes on-ledger. It holds the market's name and its
// creator, so both survive on the ledger rather than in one browser. Recording the
// creator also gives the server a trustworthy authority for creator-only actions: it
// reads the address off the vault instead of believing the caller.
const MAX_NAME = 64;
const vaultDataHex = (name, creator) =>
  convertStringToHex(JSON.stringify({ n: String(name || "").trim().slice(0, MAX_NAME), ...(creator ? { c: creator } : {}) }));

/** { name, creator } recorded on a vault. Older vaults stored a bare name string. */
function readVaultData(hex) {
  if (!hex) return { name: null, creator: null };
  let text;
  try {
    text = Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return { name: null, creator: null };
  }
  try {
    const j = JSON.parse(text);
    return { name: j.n || null, creator: j.c || null };
  } catch {
    return { name: text.trim() || null, creator: null };
  }
}

/** The creator recorded on a vault, read from the ledger. */
async function creatorOf(client, vaultId) {
  try {
    const { result } = await client.request({ command: "vault_info", vault_id: vaultId });
    return { creator: readVaultData(result.vault?.Data).creator, vault: result.vault };
  } catch {
    return { creator: null, vault: null };
  }
}

const assetOfVault = (vault) =>
  vault?.Asset?.mpt_issuance_id ? { kind: "MPT", issuanceId: vault.Asset.mpt_issuance_id } : { kind: "XRP" };

const amountOf = (asset, base) =>
  asset?.kind === "MPT" ? { mpt_issuance_id: asset.issuanceId, value: String(base) } : String(base);

function createdIndex(meta, entryType) {
  for (const n of meta?.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === entryType) return c.LedgerIndex;
  }
  return null;
}

async function send(client, wallet, tx) {
  const prepared = await client.autofill(tx);
  const res = await client.submitAndWait(wallet.sign(prepared).tx_blob);
  return { code: res.result.meta?.TransactionResult, hash: res.result.hash, meta: res.result.meta };
}

/** Confirm the creator really paid `amount` of `asset` to the desk in tx `hash`. */
async function verifyPayment(client, hash, desk, asset, amount) {
  if (!hash) return "Missing the funding payment.";
  let result;
  try {
    ({ result } = await client.request({ command: "tx", transaction: hash }));
  } catch {
    return "Funding payment not found.";
  }
  if (!result.validated || result.meta?.TransactionResult !== "tesSUCCESS") return "Funding payment did not settle.";
  const tx = result.tx_json || result;
  if (tx.TransactionType !== "Payment" || tx.Destination !== desk) return "Funding payment was not sent to the desk.";
  const paid = tx.DeliverMax ?? tx.Amount ?? result.meta?.delivered_amount;
  const want = amountOf(asset, amount);
  const ok = typeof want === "string"
    ? String(paid) === want
    : paid?.mpt_issuance_id === want.mpt_issuance_id && String(paid?.value) === want.value;
  return ok ? null : "Funding payment amount does not match.";
}

/**
 * Fees the desk has earned for one market, and how much of it has already been passed on.
 *
 * Both are derived from the ledger, so no bookkeeping is kept anywhere. Every LoanPay that
 * credits the desk appears in its history and carries a Loan node naming the broker, which
 * attributes the fee to a market. Forwards are marked with a DestinationTag derived from
 * the broker id, so previous payouts can be recognised and never counted twice.
 */
const feeTag = (brokerId) => parseInt(brokerId.slice(0, 8), 16) >>> 0;

async function deskHistory(client, account) {
  const out = [];
  let marker;
  for (let i = 0; i < 10; i += 1) {
    let result;
    try {
      ({ result } = await client.request({
        command: "account_tx", account, limit: 200, ledger_index_min: -1, ledger_index_max: -1,
        ...(marker ? { marker } : {}),
      }));
    } catch {
      break;
    }
    out.push(...(result.transactions || []));
    marker = result.marker;
    if (!marker) break;
  }
  return out;
}

/** What this transaction credited to `desk`, in the market's asset. */
function creditedToDesk(meta, desk, asset) {
  for (const n of meta?.AffectedNodes || []) {
    const m = n.ModifiedNode || n.CreatedNode;
    const ff = m?.FinalFields || m?.NewFields;
    const pf = m?.PreviousFields || {};
    if (!ff) continue;
    if (asset.kind === "XRP" && m.LedgerEntryType === "AccountRoot" && ff.Account === desk && pf.Balance !== undefined) {
      return BigInt(ff.Balance) - BigInt(pf.Balance);
    }
    if (asset.kind === "MPT" && m.LedgerEntryType === "MPToken" && ff.Account === desk && ff.MPTokenIssuanceID === asset.issuanceId) {
      return BigInt(ff.MPTAmount ?? "0") - BigInt(pf.MPTAmount ?? "0");
    }
  }
  return 0n;
}

/** Which broker a LoanPay's Loan belongs to. */
function brokerOfLoanPay(meta) {
  for (const n of meta?.AffectedNodes || []) {
    const m = n.ModifiedNode || n.DeletedNode;
    if (m?.LedgerEntryType === "Loan") return (m.FinalFields || m.NewFields || {}).LoanBrokerID || null;
  }
  return null;
}

async function feeLedger(client, desk, brokerId, asset, creator) {
  const history = await deskHistory(client, desk);
  const tag = feeTag(brokerId);
  let earned = 0n;
  let forwarded = 0n;
  for (const t of history) {
    const tx = t.tx_json || t.tx || {};
    if (t.meta?.TransactionResult !== "tesSUCCESS") continue;
    if (tx.TransactionType === "LoanPay" && brokerOfLoanPay(t.meta) === brokerId) {
      const d = creditedToDesk(t.meta, desk, asset);
      if (d > 0n) earned += d;
    }
    if (tx.TransactionType === "Payment" && tx.Account === desk && tx.Destination === creator && Number(tx.DestinationTag) === tag) {
      const paid = t.meta?.delivered_amount ?? tx.DeliverMax ?? tx.Amount;
      forwarded += typeof paid === "string" ? BigInt(paid) : BigInt(String(paid?.value ?? "0").split(".")[0]);
    }
  }
  const claimable = earned - forwarded;
  return { earned, forwarded, claimable: claimable > 0n ? claimable : 0n, tag };
}

/** A desk-owned broker with its vault, asset and recorded creator, or { error }. */
async function deskBroker(client, brokerId, deskAddress) {
  let broker;
  try {
    const { result } = await client.request({ command: "ledger_entry", index: brokerId, ledger_index: "validated" });
    broker = result.node;
  } catch {
    return { error: "That market does not exist." };
  }
  if (broker?.LedgerEntryType !== "LoanBroker") return { error: "That market does not exist." };
  if (broker.Owner !== deskAddress) return { error: "This desk does not run that market." };
  const { creator, vault } = await creatorOf(client, broker.VaultID);
  return { broker, vault, creator, asset: assetOfVault(vault) };
}

export async function POST(req) {
  const seed = process.env.OPERATOR_SEED;
  if (!seed) return Response.json({ error: "The lending desk is not configured." }, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const desk = Wallet.fromSeed(seed);
  const client = new Client(DEFAULT_NETWORK.wss, { connectionTimeout: 20000 });
  try {
    await client.connect();

    if (body.op === "create") {
      const { asset, gated, credentialType, issuer, feePct, minCoverPct, name, assetsMaximum } = body;
      if (!asset || (asset.kind === "MPT" && !asset.issuanceId)) {
        return Response.json({ error: "Missing the vault asset." }, { status: 400 });
      }
      if (gated && !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer || "")) {
        return Response.json({ error: "A gated vault needs a credential issuer." }, { status: 400 });
      }
      // The desk must be able to hold an MPT vault asset to receive cover in it.
      if (asset.kind === "MPT") {
        await send(client, desk, { TransactionType: "MPTokenAuthorize", Account: desk.address, MPTokenIssuanceID: asset.issuanceId }).catch(() => null);
      }

      let domainId = null;
      if (gated) {
        // The desk owns the domain, but it trusts credentials issued by the market's
        // creator, so they admit depositors from their own wallet. A domain may list any
        // issuer, so no server-side credential endpoint (and no open admission) is needed.
        const dom = await send(client, desk, {
          TransactionType: "PermissionedDomainSet",
          Account: desk.address,
          AcceptedCredentials: [{ Credential: { Issuer: issuer, CredentialType: credentialType } }],
        });
        if (dom.code !== "tesSUCCESS") return Response.json({ error: `Could not create the access domain (${dom.code}).` }, { status: 502 });
        domainId = createdIndex(dom.meta, "PermissionedDomain");
      }

      const vaultTx = {
        TransactionType: "VaultCreate",
        Account: desk.address,
        Asset: asset.kind === "MPT" ? { mpt_issuance_id: asset.issuanceId } : { currency: "XRP" },
        WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
      };
      // The name lives on the ledger in Data, so a vault found by anyone carries its own
      // name instead of relying on whatever a single browser happens to remember.
      if (name || issuer) vaultTx.Data = vaultDataHex(name, issuer);
      if (assetsMaximum) vaultTx.AssetsMaximum = String(assetsMaximum);
      if (domainId) {
        vaultTx.Flags = VaultCreateFlags.tfVaultPrivate;
        vaultTx.DomainID = domainId;
      }
      const vc = await send(client, desk, vaultTx);
      if (vc.code !== "tesSUCCESS") return Response.json({ error: `Could not create the vault (${vc.code}).` }, { status: 502 });
      const vaultId = createdIndex(vc.meta, "Vault");

      const { result: vi } = await client.request({ command: "vault_info", vault_id: vaultId });
      const shareMptId = vi.vault?.ShareMPTID || null;

      const bk = await send(client, desk, {
        TransactionType: "LoanBrokerSet",
        Account: desk.address,
        VaultID: vaultId,
        ManagementFeeRate: Math.round(Number(feePct || 0) * 1000), // 1e5 scale: 100000 = 100%
        DebtMaximum: "1000000000000",
        CoverRateMinimum: Math.round(Number(minCoverPct || 0) * 1000),
        CoverRateLiquidation: 20000,
      });
      if (bk.code !== "tesSUCCESS") return Response.json({ error: `Could not create the broker (${bk.code}).` }, { status: 502 });

      return Response.json({ vaultId, shareMptId, brokerId: createdIndex(bk.meta, "LoanBroker"), domainId, operator: desk.address });
    }

    if (body.op === "cover") {
      const { brokerId, asset, amount, paymentHash } = body;
      if (!brokerId || !asset || !amount) return Response.json({ error: "Missing cover details." }, { status: 400 });
      const bad = await verifyPayment(client, paymentHash, desk.address, asset, amount);
      if (bad) return Response.json({ error: bad }, { status: 422 });
      const r = await send(client, desk, {
        TransactionType: "LoanBrokerCoverDeposit", Account: desk.address, LoanBrokerID: brokerId, Amount: amountOf(asset, amount),
      });
      return Response.json({ code: r.code, hash: r.hash });
    }

    // Update vault settings the ledger allows to change after creation: the on-chain name
    // (Data) and the deposit cap (AssetsMaximum). VaultSet is owner-only, and the desk owns
    // vaults created here, so it signs. Open vs gated cannot be changed: adding a DomainID
    // to a vault not created private is rejected tecNO_PERMISSION.
    if (body.op === "settings") {
      const { vaultId, name, assetsMaximum } = body;
      if (!/^[0-9A-Fa-f]{64}$/.test(vaultId || "")) return Response.json({ error: "Missing the vault." }, { status: 400 });
      if (name === undefined && assetsMaximum === undefined) {
        return Response.json({ error: "Nothing to change." }, { status: 400 });
      }
      if (assetsMaximum !== undefined && !/^\d+$/.test(String(assetsMaximum))) {
        return Response.json({ error: "Deposit cap must be a whole number." }, { status: 400 });
      }
      const tx = { TransactionType: "VaultSet", Account: desk.address, VaultID: vaultId };
      if (name !== undefined) {
        const { creator } = await creatorOf(client, vaultId);
        tx.Data = vaultDataHex(name, creator);
      }
      if (assetsMaximum !== undefined) tx.AssetsMaximum = String(assetsMaximum);
      const r = await send(client, desk, tx);
      return Response.json({ code: r.code, hash: r.hash });
    }

    // Loan lifecycle actions the desk must sign because it owns the broker: impair a loan
    // that looks bad, undo that, or default one past its grace period. The ledger enforces
    // the timing rules, so these cannot be used to default a healthy loan.
    if (body.op === "loan") {
      const { loanId, action } = body;
      const flags = { default: 0x00010000, impair: 0x00020000, unimpair: 0x00040000 };
      if (!/^[0-9A-Fa-f]{64}$/.test(loanId || "")) return Response.json({ error: "Missing the loan." }, { status: 400 });
      if (!flags[action]) return Response.json({ error: "Unknown loan action." }, { status: 400 });
      const r = await send(client, desk, {
        TransactionType: "LoanManage", Account: desk.address, LoanID: loanId, Flags: flags[action],
      });
      return Response.json({ code: r.code, hash: r.hash });
    }

    // Delete a settled loan object so it stops holding an owner reserve.
    if (body.op === "loanDelete") {
      const { loanId } = body;
      if (!/^[0-9A-Fa-f]{64}$/.test(loanId || "")) return Response.json({ error: "Missing the loan." }, { status: 400 });
      const r = await send(client, desk, { TransactionType: "LoanDelete", Account: desk.address, LoanID: loanId });
      return Response.json({ code: r.code, hash: r.hash });
    }

    // Return cover to the market's creator. The destination is read off the vault, never
    // taken from the request, so this can only ever pay the account that funded it.
    if (body.op === "coverWithdraw") {
      const { brokerId, amount } = body;
      if (!/^[0-9A-Fa-f]{64}$/.test(brokerId || "")) return Response.json({ error: "Missing the market." }, { status: 400 });
      if (!/^\d+$/.test(String(amount || ""))) return Response.json({ error: "Amount must be a whole number." }, { status: 400 });
      const m = await deskBroker(client, brokerId, desk.address);
      if (m.error) return Response.json({ error: m.error }, { status: 422 });
      if (!m.creator) return Response.json({ error: "This market has no recorded creator to pay." }, { status: 422 });
      const w = await send(client, desk, {
        TransactionType: "LoanBrokerCoverWithdraw", Account: desk.address, LoanBrokerID: brokerId, Amount: amountOf(m.asset, amount),
      });
      if (w.code !== "tesSUCCESS") return Response.json({ code: w.code, hash: w.hash });
      const pay = await send(client, desk, {
        TransactionType: "Payment", Account: desk.address, Destination: m.creator, Amount: amountOf(m.asset, amount),
      });
      return Response.json({ code: pay.code, hash: pay.hash, to: m.creator });
    }

    // What this market has earned in fees, and what is still owed to its creator.
    if (body.op === "fees" || body.op === "feesWithdraw") {
      const { brokerId } = body;
      if (!/^[0-9A-Fa-f]{64}$/.test(brokerId || "")) return Response.json({ error: "Missing the market." }, { status: 400 });
      const m = await deskBroker(client, brokerId, desk.address);
      if (m.error) return Response.json({ error: m.error }, { status: 422 });
      if (!m.creator) return Response.json({ error: "This market has no recorded creator to pay." }, { status: 422 });
      const f = await feeLedger(client, desk.address, brokerId, m.asset, m.creator);
      if (body.op === "fees") {
        return Response.json({ earned: f.earned.toString(), forwarded: f.forwarded.toString(), claimable: f.claimable.toString(), creator: m.creator });
      }
      if (f.claimable <= 0n) return Response.json({ error: "There are no fees to pass on yet." }, { status: 422 });
      const pay = await send(client, desk, {
        TransactionType: "Payment",
        Account: desk.address,
        Destination: m.creator,
        DestinationTag: f.tag,
        Amount: amountOf(m.asset, f.claimable.toString()),
      });
      return Response.json({ code: pay.code, hash: pay.hash, paid: f.claimable.toString(), to: m.creator });
    }

    // Wind a market down. The broker goes first because it references the vault, and the
    // ledger refuses both while anything is outstanding, so an in-use market cannot vanish.
    if (body.op === "close") {
      const { vaultId, brokerId } = body;
      if (!/^[0-9A-Fa-f]{64}$/.test(vaultId || "")) return Response.json({ error: "Missing the vault." }, { status: 400 });
      if (brokerId) {
        const b = await send(client, desk, { TransactionType: "LoanBrokerDelete", Account: desk.address, LoanBrokerID: brokerId });
        if (b.code !== "tesSUCCESS") {
          return Response.json({ error: `The broker could not be closed (${b.code}). Settle every loan and remove the cover first.` }, { status: 422 });
        }
      }
      const v = await send(client, desk, { TransactionType: "VaultDelete", Account: desk.address, VaultID: vaultId });
      if (v.code !== "tesSUCCESS") {
        return Response.json({ error: `The vault could not be closed (${v.code}). It must be empty first.` }, { status: 422 });
      }
      return Response.json({ code: v.code, hash: v.hash });
    }

    // Repoint a desk-owned domain at a new credential issuer. PermissionedDomainSet with
    // DomainID updates in place, and a vault already bound to the domain honours the new
    // issuer immediately. The desk can only update domains it owns; anything else fails
    // on the ledger. This lets a market creator become the issuer for their own vault.
    if (body.op === "domain") {
      const { vaultId, credentialType } = body;
      if (!/^[0-9A-Fa-f]{64}$/.test(vaultId || "")) return Response.json({ error: "Missing the vault." }, { status: 400 });
      if (!/^[0-9A-Fa-f]{2,128}$/.test(credentialType || "")) return Response.json({ error: "Missing the credential type." }, { status: 400 });
      // Both the domain and the issuer come from the ledger: the gate can only ever be
      // pointed at the account recorded as this vault's creator.
      const { creator, vault } = await creatorOf(client, vaultId);
      const domainId = vault?.shares?.DomainID;
      if (!domainId) return Response.json({ error: "That vault is not gated." }, { status: 422 });
      if (!creator) return Response.json({ error: "This vault has no recorded creator." }, { status: 422 });
      const issuer = creator;
      const r = await send(client, desk, {
        TransactionType: "PermissionedDomainSet",
        Account: desk.address,
        DomainID: domainId,
        AcceptedCredentials: [{ Credential: { Issuer: issuer, CredentialType: credentialType } }],
      });
      return Response.json({ code: r.code, hash: r.hash });
    }

    // No credential-issuing or loan-default op here on purpose: those are owner powers
    // with no caller authentication available, so exposing them would let anyone admit
    // themselves to a gated vault or force a default. The desk performs them by
    // connecting its own wallet to the vault manager.
    return Response.json({ error: "Unknown operation." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }
}
