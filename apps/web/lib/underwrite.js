// The desk's underwriting decision, server-side.
//
// The desk's counterparty signature is the only thing that makes a loan exist, so
// refusing to sign IS the credit gate: nothing here needs a protocol change. This module
// gathers the facts from the ledger (the borrower's loan record, the collateral they have
// locked to the desk, the credential they hold, the state of the pool) and hands them to
// the pure policy in lib/credit.js.
//
// The same function serves /api/quote and /api/originate, so the rate and limit a
// borrower is shown are the ones the desk then checks the signed loan against.

import { assetOfVault } from "./asset";
import { baseUnits } from "./format";
import {
  TIERS,
  baseRate,
  bindingLimit,
  creditProfile,
  loanRate,
  longDatedExposure,
  offeredSchedules,
  principalCaps,
  utilisationBps,
} from "./credit";

const RIPPLE_EPOCH = 946684800;
const TF_VAULT_PRIVATE = 0x00010000;
const LSF_CREDENTIAL_ACCEPTED = 0x00010000;
const PAGE_GUARD = 20;

const nowRipple = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

/** Every object of `type` owned by `account`, following markers. Bounded. */
async function accountObjects(client, account, type) {
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

/** Base-unit value of an escrowed amount, but only if it is this market's asset. */
function escrowValue(amount, asset) {
  if (asset.kind === "MPT") {
    if (!amount || typeof amount !== "object" || amount.mpt_issuance_id !== asset.issuanceId) return 0n;
    return baseUnits(amount.value);
  }
  return typeof amount === "string" ? baseUnits(amount) : 0n;
}

/**
 * Collateral the borrower has locked to the desk, in this market's asset. Escrow in
 * another asset is not counted: valuing it would need a price, and this desk has no
 * oracle. Whether a given escrow counts depends on the term being priced, so the deadline
 * is kept and applied per option rather than here.
 */
async function collateralTo(client, borrower, desk, asset) {
  const escrows = await accountObjects(client, borrower, "escrow").catch(() => []);
  return escrows
    .filter((e) => e.Destination === desk)
    .map((e) => ({ value: escrowValue(e.Amount, asset), cancelAfter: e.CancelAfter == null ? null : Number(e.CancelAfter) }))
    .filter((e) => e.value > 0n);
}

/** Collateral that outlives a loan of `termSeconds`, and so can back one. */
const collateralFor = (escrows, now, termSeconds) =>
  escrows.reduce((sum, e) => (e.cancelAfter == null || e.cancelAfter >= now + termSeconds ? sum + e.value : sum), 0n);

/** True when the borrower holds an accepted, unexpired credential this market's gate accepts. */
async function holdsMarketCredential(client, vault, borrower) {
  if ((Number(vault.Flags ?? 0) & TF_VAULT_PRIVATE) === 0) return false;
  const domainId = vault.shares?.DomainID;
  if (!domainId) return false;
  try {
    const { result } = await client.request({ command: "ledger_entry", index: domainId, ledger_index: "validated" });
    const wanted = (result.node?.AcceptedCredentials || []).map((a) => a.Credential).filter(Boolean);
    if (wanted.length === 0) return false;
    const creds = await accountObjects(client, borrower, "credential");
    const now = nowRipple();
    return creds.some(
      (c) =>
        c.Subject === borrower &&
        (Number(c.Flags ?? 0) & LSF_CREDENTIAL_ACCEPTED) !== 0 &&
        (c.Expiration == null || Number(c.Expiration) > now) &&
        wanted.some((w) => w.Issuer === c.Issuer && w.CredentialType === c.CredentialType),
    );
  } catch {
    return false;
  }
}

/** Why nobody can draw from this market right now, or null. */
function marketRefusal(vault) {
  // A brand new market quotes every limit as 0, and "capped by your credit limit" reads as
  // a judgement on the borrower when the truth is that the pool is empty.
  if (baseUnits(vault.AssetsTotal) === 0n) return "This market has no deposits yet, so there is nothing to lend.";
  return null;
}

/** Why this borrower cannot draw at all right now, or null when they can. */
function refusal(profile) {
  // Most serious first: a borrower who is both overdue and already borrowing here should
  // be told about the arrears, not about the open loan.
  if (profile.defaults > 0) return "A past loan of yours defaulted, so this desk will not lend to you.";
  if (profile.overdue > 0 || profile.impaired > 0) return "You have a loan that is behind on payments. Bring it current first.";
  if (profile.activeHere > 0) return "You already have an open loan in this market. Repay it before drawing another.";
  return null;
}

/**
 * Price and size a loan for `borrower` against `brokerId`. Returns { error } when the
 * market is not one this desk runs, otherwise the full decision. `maxPrincipal` is a
 * BigInt in the asset's base units and is 0 when the desk will not lend.
 */
export async function underwrite(client, { brokerId, borrower, deskAddress }) {
  if (!/^[0-9A-Fa-f]{64}$/.test(brokerId || "")) return { error: "That market does not exist." };
  if (!borrower) return { error: "Missing the borrower." };

  let broker;
  try {
    const { result } = await client.request({ command: "ledger_entry", index: brokerId, ledger_index: "validated" });
    broker = result.node;
  } catch {
    return { error: "That market does not exist." };
  }
  if (broker?.LedgerEntryType !== "LoanBroker") return { error: "That market does not exist." };
  if (broker.Owner !== deskAddress) return { error: "This desk does not run that market." };

  const { result } = await client.request({ command: "vault_info", vault_id: broker.VaultID });
  const vault = result.vault;
  if (!vault) return { error: "That market has no vault." };

  const asset = assetOfVault(vault);
  const now = nowRipple();
  // The broker's pseudo-account owns every loan it has made, so the whole book is one read.
  // The duration budget is a property of that book, not of the borrower.
  const [loanObjects, bookLoans, escrows, verified] = await Promise.all([
    accountObjects(client, borrower, "loan").catch(() => []),
    accountObjects(client, broker.Account, "loan").catch(() => []),
    collateralTo(client, borrower, deskAddress, asset),
    holdsMarketCredential(client, vault, borrower),
  ]);
  const longExposure = longDatedExposure(bookLoans.map((loan) => ({ loan })));

  const profile = creditProfile(loanObjects.map((loan) => ({ loan })), brokerId, now);
  const utilBps = utilisationBps(vault);
  const blocked = marketRefusal(vault) || refusal(profile);

  // Every schedule is priced and sized on its own: a longer loan carries a term premium
  // and may take less of the pool, and only collateral that outlives it backs it.
  const options = offeredSchedules().map((o) => {
    const collateralBase = collateralFor(escrows, now, o.termSeconds);
    const limit = bindingLimit(
      principalCaps({ vault, broker, profile, termSeconds: o.termSeconds, longExposure, collateralBase, verified }),
    );
    return {
      ...o,
      collateral: collateralBase,
      rate: loanRate({ utilBps, profile, verified, termSeconds: o.termSeconds, payments: o.payments }),
      maxPrincipal: blocked ? 0n : limit.cap,
      reason: blocked || `Capped by ${limit.label}.`,
    };
  });

  return {
    vault,
    broker,
    asset,
    profile,
    verified,
    utilBps,
    marketRate: baseRate(utilBps),
    tier: TIERS[profile.tier].label,
    options,
  };
}

/** The parts of a decision a browser needs, with every amount as a string. */
export const quoteJson = (u) => ({
  marketRate: u.marketRate,
  utilBps: u.utilBps,
  tier: u.tier,
  verified: u.verified,
  repaid: u.profile.repaid,
  exposure: u.profile.exposure.toString(),
  options: u.options.map((o) => ({
    termId: o.termId,
    termLabel: o.termLabel,
    payments: o.payments,
    schedule: o.schedule,
    rate: o.rate,
    collateral: o.collateral.toString(),
    maxPrincipal: o.maxPrincipal.toString(),
    reason: o.reason,
  })),
});
