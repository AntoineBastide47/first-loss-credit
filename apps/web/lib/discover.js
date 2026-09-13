"use client";

// Vault discovery. Markets are not just what this browser created: every vault the desk
// runs is on the ledger and can be found. `account_objects` lists an account's Vault and
// LoanBroker objects, and a broker names its VaultID, so the two join into a market.
// A vault id can also be looked up directly, so a market can be shared as an id.

import { convertHexToString } from "xrpl";
import { getClient } from "./xrpl-client";
import { DESK_OPERATOR } from "./market";
import { shortId } from "./format";

const TF_VAULT_PRIVATE = 0x00010000;
const PAGE_GUARD = 20;

/** All objects of `type` owned by `account`, following markers. Bounded. */
async function accountObjects(account, type) {
  const client = await getClient();
  const out = [];
  let marker;
  for (let i = 0; i < PAGE_GUARD; i += 1) {
    const { result } = await client.request({
      command: "account_objects", account, type, limit: 400, ...(marker ? { marker } : {}),
    });
    out.push(...(result.account_objects || []));
    marker = result.marker;
    if (!marker) break;
  }
  return out;
}

/** Asset descriptor for a vault, reading the MPT issuance for scale and ticker. */
async function assetOf(vault) {
  const id = vault?.Asset?.mpt_issuance_id;
  if (!id) return { kind: "XRP" };
  let scale = 0;
  let symbol = "TOKEN";
  try {
    const client = await getClient();
    const { result } = await client.request({ command: "ledger_entry", mpt_issuance: id, ledger_index: "validated" });
    scale = Number(result.node?.AssetScale ?? 0);
    const metaHex = result.node?.MPTokenMetadata;
    if (metaHex) {
      const parsed = JSON.parse(convertHexToString(metaHex));
      if (parsed?.ticker) symbol = String(parsed.ticker).toUpperCase().slice(0, 8);
    }
  } catch {
    /* fall back to defaults */
  }
  return { kind: "MPT", issuanceId: id, scale, symbol };
}

/** The credential gate behind a vault's share domain, or null when it is open. */
async function gateOf(domainId) {
  if (!domainId) return null;
  try {
    const client = await getClient();
    const { result } = await client.request({ command: "ledger_entry", index: domainId, ledger_index: "validated" });
    const cred = result.node?.AcceptedCredentials?.[0]?.Credential;
    if (!cred) return null;
    return { issuer: cred.Issuer, credentialType: convertHexToString(cred.CredentialType) };
  } catch {
    return null;
  }
}

/** Build a market record from a Vault ledger object and its broker. */
async function marketFrom(vaultId, broker) {
  const client = await getClient();
  const { result } = await client.request({ command: "vault_info", vault_id: vaultId });
  const vault = result.vault;
  if (!vault) return null;
  const asset = await assetOf(vault);
  const domainId = vault.shares?.DomainID || null;
  const gate = (Number(vault.Flags ?? 0) & TF_VAULT_PRIVATE) !== 0 ? await gateOf(domainId) : null;
  const sym = asset.kind === "MPT" ? asset.symbol : "XRP";
  // Vaults carry their own name on-ledger in Data, so a market found by anyone shows the
  // name its creator gave it rather than a generated label.
  let onChainName = null;
  try {
    if (vault.Data) onChainName = convertHexToString(vault.Data).trim() || null;
  } catch {
    onChainName = null;
  }
  return {
    id: `chain-${vaultId.slice(0, 10).toLowerCase()}`,
    name: onChainName || `${sym} vault ${shortId(vaultId, 4)}`,
    asset,
    vaultId,
    shareMptId: vault.ShareMPTID,
    brokerId: broker.index,
    operator: vault.Owner,
    discovered: true,
    ...(gate ? { domainId, gate } : {}),
  };
}

/** Every market the desk runs, read from the ledger. */
export async function discoverMarkets() {
  const [vaults, brokers] = await Promise.all([
    accountObjects(DESK_OPERATOR, "vault"),
    accountObjects(DESK_OPERATOR, "loan_broker"),
  ]);
  const brokerByVault = new Map(brokers.map((b) => [b.VaultID, b]));
  const found = await Promise.all(
    vaults
      .filter((v) => brokerByVault.has(v.index))
      .map((v) => marketFrom(v.index, brokerByVault.get(v.index)).catch(() => null)),
  );
  return found.filter(Boolean);
}

/** Look up a single vault by id and build its market, or throw with a reason. */
export async function lookupVault(vaultId) {
  const client = await getClient();
  const { result } = await client.request({ command: "vault_info", vault_id: vaultId });
  const vault = result.vault;
  if (!vault) throw new Error("No vault with that id.");
  const brokers = await accountObjects(vault.Owner, "loan_broker");
  const broker = brokers.find((b) => b.VaultID === vaultId);
  if (!broker) throw new Error("That vault has no loan broker, so it is not a lending market.");
  return marketFrom(vaultId, broker);
}
