// Phase 3.2 — MPT-Asset Vault
//
// Create a Single Asset Vault whose asset is an MPT, deposit and withdraw the MPT,
// and confirm the forced-scale behavior: an MPT vault's share Scale is 0 and the
// Scale field must be ABSENT from VaultCreate (sending Scale, even 0, is rejected by
// client-side validation and not normalized).
//
// Two distinct scales: the vault share Scale (0 here) is SEPARATE from the MPT's own
// AssetScale. The Asset field carries identity only ({ mpt_issuance_id }, no value);
// the deposit/withdraw Amount carries the value ({ mpt_issuance_id, value }).
//
// Independence: this phase issues its own MPT via the shared MPT builder, authorizes
// the lender, and builds the vault. It imports no other phase.
//
// Run:  node part-3/3.2_mpt_asset_vault.mjs

import { validate } from "xrpl";
import { connect, fundAccounts, submitAndWait, readVault, logFriction } from "../lib/index.mjs";
import { assert, makeRecorder, createVault, vaultDeposit, shareBalance } from "../lib/lending.mjs";
import { MPTokenIssuanceCreateFlags as F, createMptIssuance, authorizeMpt, mptBalance } from "../lib/mpt.mjs";

const MPT_ASSET_SCALE = 2; // the MPT's own scale, separate from the vault share Scale
const MINT = "1000"; // MPT base units minted to the lender
const DEPOSIT = "500"; // MPT base units deposited into the vault

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // Preconditions: issuer, lender, owner (vault owner).
    const [issuer, lender, owner] = await fundAccounts(client, 3);
    console.log(`issuer=${issuer.address}\nlender=${lender.address}\nowner=${owner.address}`);

    // Issue a transferable MPT (no RequireAuth, so the vault pseudo-account can hold
    // it without issuer authorization), opt the lender in, and mint to the lender.
    const { hash: mptHash, issuanceId } = await createMptIssuance(client, issuer, {
      flags: F.tfMPTCanTransfer,
      assetScale: MPT_ASSET_SCALE,
      maximumAmount: "1000000000",
    });
    record("MPTokenIssuanceCreate", mptHash);
    console.log(`  MPTokenIssuanceID=${issuanceId} (AssetScale=${MPT_ASSET_SCALE})`);

    record("MPTokenAuthorize(lender opt-in)", (await authorizeMpt(client, lender, issuanceId)).hash);
    record("Payment(mint to lender)", (await submitAndWait(client, {
      TransactionType: "Payment", Account: issuer.address, Destination: lender.address,
      Amount: { mpt_issuance_id: issuanceId, value: MINT },
    }, issuer)).hash);
    assert((await mptBalance(client, lender, issuanceId)) === MINT, `lender minted ${MINT} MPT`);

    // Step 1: VaultCreate with an MPT asset. Asset is identity only (no value); Scale
    // is OMITTED (the shared builder never sends it).
    const { hash: vaultHash, vaultId, shareMptId, vault: created } = await createVault(client, owner, {
      asset: { mpt_issuance_id: issuanceId },
    });
    record("VaultCreate", vaultHash);
    console.log(`  VaultID=${vaultId}\n  ShareMPTID=${shareMptId}`);
    assert(Number(created.Scale ?? 0) === 0, "MPT vault Scale reads as 0");

    // Step 2: lender deposits the MPT. Amount carries the value.
    const deposit = await vaultDeposit(client, lender, vaultId, { mpt_issuance_id: issuanceId, value: DEPOSIT });
    record("VaultDeposit", deposit.hash);
    let vault = await readVault(client, vaultId);
    const sharesAfterDeposit = await shareBalance(client, lender.address, shareMptId);
    console.log(`  AssetsTotal=${vault.AssetsTotal} AssetsAvailable=${vault.AssetsAvailable}` +
      ` lenderShares=${sharesAfterDeposit} lenderMPT=${await mptBalance(client, lender, issuanceId)}`);
    assert(vault.AssetsTotal === DEPOSIT, "AssetsTotal == MPT deposit");
    assert(vault.AssetsAvailable === DEPOSIT, "AssetsAvailable == MPT deposit");
    // Scale 0 -> 10^0 = 1: initial shares equal the deposited base units.
    assert(sharesAfterDeposit === DEPOSIT, "initial shares == deposit (Scale 0, 10^0 = 1)");
    assert((await mptBalance(client, lender, issuanceId)) === String(Number(MINT) - Number(DEPOSIT)),
      "lender MPT reduced by the deposit");

    // Step 3: withdraw all shares (share MPT amount) to receive the MPT back.
    const withdraw = await submitAndWait(client, {
      TransactionType: "VaultWithdraw", Account: lender.address, VaultID: vaultId,
      Amount: { mpt_issuance_id: shareMptId, value: sharesAfterDeposit },
    }, lender);
    record("VaultWithdraw", withdraw.hash);
    vault = await readVault(client, vaultId);
    const lenderMptAfter = await mptBalance(client, lender, issuanceId);
    const sharesAfterWithdraw = await shareBalance(client, lender.address, shareMptId);
    console.log(`  after withdraw: AssetsTotal=${vault.AssetsTotal ?? "0"} lenderMPT=${lenderMptAfter}` +
      ` lenderShares=${sharesAfterWithdraw}`);
    assert(lenderMptAfter === MINT, "withdraw returned the full MPT to the lender");
    assert(sharesAfterWithdraw === "0", "lender redeemed all shares");

    // Negative control: VaultCreate WITH an explicit Scale on an MPT asset is rejected
    // by client-side validation (not normalized), so there is no transaction hash.
    let scaleError = null;
    try {
      validate({
        TransactionType: "VaultCreate", Account: owner.address,
        Asset: { mpt_issuance_id: issuanceId }, Scale: 0,
      });
    } catch (e) {
      scaleError = e.message;
    }
    console.log(`  VaultCreate with Scale on MPT asset -> validation error: ${scaleError}`);
    assert(scaleError !== null && /Scale parameter must not be provided/.test(scaleError),
      "explicit Scale on an MPT asset is rejected client-side (no tx hash)");

    printLinks();

    // Friction to capture (plan 3.2).
    logFriction({
      phase: "3.2", surface: "sdk", feature: "xls-65", tx_type: "VaultCreate",
      note: "For an MPT asset, Scale must be ABSENT, not 0. Sending Scale (even 0) throws client-side 'Scale parameter must not be provided for XRP or MPT assets'; it is not normalized. Discovered by the rejected validation, not from an obvious doc note.",
    });
    logFriction({
      phase: "3.2", surface: "sdk", feature: "xls-33", tx_type: "VaultDeposit",
      note: "Vault Asset is identity only: { mpt_issuance_id } with NO value. The deposit/withdraw Amount is { mpt_issuance_id, value }. The two shapes differ and mixing them is easy.",
    });

    console.log("\nPhase 3.2 complete: MPT-asset vault with Scale 0; deposit and withdraw round-trip the MPT.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ phase: "3.2", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
