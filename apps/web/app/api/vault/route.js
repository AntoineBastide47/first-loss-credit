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

// Vault Data is capped at 256 bytes on-ledger; a name is far shorter than that.
const MAX_NAME = 64;
const nameHex = (name) => convertStringToHex(String(name || "").trim().slice(0, MAX_NAME));

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
      if (name) vaultTx.Data = nameHex(name);
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
      if (name !== undefined) tx.Data = nameHex(name);
      if (assetsMaximum !== undefined) tx.AssetsMaximum = String(assetsMaximum);
      const r = await send(client, desk, tx);
      return Response.json({ code: r.code, hash: r.hash });
    }

    // Repoint a desk-owned domain at a new credential issuer. PermissionedDomainSet with
    // DomainID updates in place, and a vault already bound to the domain honours the new
    // issuer immediately. The desk can only update domains it owns; anything else fails
    // on the ledger. This lets a market creator become the issuer for their own vault.
    if (body.op === "domain") {
      const { domainId, issuer, credentialType } = body;
      if (!/^[0-9A-Fa-f]{64}$/.test(domainId || "")) return Response.json({ error: "Missing the access domain." }, { status: 400 });
      if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer || "")) return Response.json({ error: "Missing a credential issuer." }, { status: 400 });
      if (!/^[0-9A-Fa-f]{2,128}$/.test(credentialType || "")) return Response.json({ error: "Missing the credential type." }, { status: 400 });
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
