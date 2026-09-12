// Phase 4.2 — Application-Verified Collateralized Origination
//
// Originate a loan backed by token collateral the borrower locks in escrow. The link
// is APPLICATION-enforced: LoanSet does not verify any escrow and there is no protocol
// binding between a loan and an escrow. The application reads the validated escrow and
// checks owner/destination/asset/amount/timing BEFORE it submits LoanSet.
//
// There is no persistent on-chain link in either direction. LoanSet.Data is a
// transaction breadcrumb only; the escrow<->loan mapping is kept in application state.
//
// Independence: this phase issues its own collateral token, funds a vault, creates a
// broker with cover, locks collateral in escrow, then originates the loan. It imports
// no other phase.
//
// Run:  node part-4/4.2_app_verified_collateralized_origination.mjs

import { convertStringToHex } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  readLedgerEntry,
  logFriction,
} from "../lib/index.mjs";
import {
  assert,
  makeRecorder,
  createVault,
  vaultDeposit,
  createBroker,
  depositCover,
  originateLoan,
} from "../lib/lending.mjs";
import { MPTokenIssuanceCreateFlags as F, createMptIssuance, authorizeMpt } from "../lib/mpt.mjs";
import { makeCondition, createEscrow, readEscrow } from "../lib/escrow.mjs";

const COLLATERAL = "500"; // required collateral in MPT base units

/**
 * Off-ledger collateral gate. Returns { ok, reasons }. The application MUST pass this
 * before submitting LoanSet, because the protocol does not check the escrow.
 */
function verifyCollateral(escrow, req) {
  const reasons = [];
  if (!escrow) return { ok: false, reasons: ["escrow not found on a validated ledger"] };
  if (escrow.Account !== req.owner) reasons.push(`owner ${escrow.Account} != ${req.owner}`);
  if (escrow.Destination !== req.destination) reasons.push(`destination ${escrow.Destination} != ${req.destination}`);
  const amt = escrow.Amount;
  if (typeof amt !== "object" || amt.mpt_issuance_id !== req.issuanceId) {
    reasons.push(`asset ${JSON.stringify(amt)} != MPT ${req.issuanceId}`);
  } else if (BigInt(amt.value) < BigInt(req.minAmount)) {
    reasons.push(`amount ${amt.value} < required ${req.minAmount}`);
  }
  if ((escrow.CancelAfter ?? 0) < req.cancelAfterAtLeast) {
    reasons.push(`CancelAfter ${escrow.CancelAfter} reclaimable before loan end ${req.cancelAfterAtLeast}`);
  }
  return { ok: reasons.length === 0, reasons };
}

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();
  const appState = {}; // the escrow<->loan mapping lives here, not on-chain

  try {
    // Preconditions: issuer, lender, owner (vault + broker), borrower.
    const [issuer, lender, owner, borrower] = await fundAccounts(client, 4);
    console.log(`issuer=${issuer.address}\nlender=${lender.address}\nowner=${owner.address}\nborrower=${borrower.address}`);

    // Escrow-eligible collateral MPT minted to the borrower.
    const { hash: mptHash, issuanceId } = await createMptIssuance(client, issuer, {
      flags: F.tfMPTCanEscrow | F.tfMPTCanTransfer, assetScale: 0, maximumAmount: "1000000",
    });
    record("MPTokenIssuanceCreate (collateral)", mptHash);
    for (const acct of [borrower, owner]) await authorizeMpt(client, acct, issuanceId);
    await submitAndWait(client, {
      TransactionType: "Payment", Account: issuer.address, Destination: borrower.address,
      Amount: { mpt_issuance_id: issuanceId, value: "1000" },
    }, issuer);

    // XRP vault funded by the lender; broker with cover and debt capacity.
    const { hash: vaultHash, vaultId } = await createVault(client, owner);
    record("VaultCreate", vaultHash);
    record("VaultDeposit", (await vaultDeposit(client, lender, vaultId, "200000000")).hash); // 200 XRP
    const { hash: brokerHash, brokerId } = await createBroker(client, owner, vaultId);
    record("LoanBrokerSet", brokerHash);
    record("LoanBrokerCoverDeposit", (await depositCover(client, owner, brokerId, "50000000")).hash); // 50 XRP

    // Loan term window; escrow CancelAfter must sit beyond the loan's final due date so
    // the borrower cannot reclaim collateral mid-loan.
    const base = (await client.request({ command: "ledger", ledger_index: "validated" })).result.ledger.close_time;
    const loanEnd = base + 3600;
    const { condition } = makeCondition();

    // Step 1: borrower locks collateral in escrow. Destination is the broker OWNER (not
    // the broker pseudo-account, whose assets are protocol-governed).
    const escrow = await createEscrow(client, borrower, {
      amount: { mpt_issuance_id: issuanceId, value: COLLATERAL },
      destination: owner, finishAfter: base + 10, cancelAfter: loanEnd + 600, condition,
    });
    record("EscrowCreate (collateral)", escrow.hash);
    console.log(`  collateral escrow: owner=${borrower.address} seq=${escrow.sequence}`);

    const escrowObj = await readEscrow(client, borrower, escrow.sequence);

    // Step 2a (abort path): a mismatched requirement must stop origination.
    const tooHigh = verifyCollateral(escrowObj, {
      owner: borrower.address, destination: owner.address, issuanceId,
      minAmount: "800", cancelAfterAtLeast: loanEnd,
    });
    console.log(`  gate (require 800) -> ok=${tooHigh.ok} reasons=${JSON.stringify(tooHigh.reasons)}`);
    assert(!tooHigh.ok, "application gate aborts origination when collateral is insufficient");

    // Step 2b: the real requirement passes.
    const gate = verifyCollateral(escrowObj, {
      owner: borrower.address, destination: owner.address, issuanceId,
      minAmount: COLLATERAL, cancelAfterAtLeast: loanEnd,
    });
    console.log(`  gate (require ${COLLATERAL}) -> ok=${gate.ok}`);
    assert(gate.ok, "application gate passes for a matching escrow");

    // Step 3: only now originate. Record the escrow reference in LoanSet.Data (a
    // transaction breadcrumb) AND in application state (the reliable mapping).
    const dataRef = convertStringToHex(`escrow:${borrower.address}:${escrow.sequence}`);
    const loan = await originateLoan(client, {
      borrower, owner, brokerId, principal: "30000000", // 30 XRP
      terms: { PaymentInterval: 3600, PaymentTotal: 1, GracePeriod: 300, Data: dataRef },
    });
    record("LoanSet", loan.hash);
    appState[loan.loanId] = { escrowOwner: borrower.address, escrowSequence: escrow.sequence, issuanceId };
    console.log(`  appState[${loan.loanId}] = ${JSON.stringify(appState[loan.loanId])}`);

    // The ledger imposes NO escrow<->loan constraint: both objects are independent.
    const loanObj = await readLedgerEntry(client, loan.loanId);
    assert(escrowObj.Account === borrower.address && escrowObj.Destination === owner.address,
      "escrow object holds collateral for owner, with no loan reference");
    assert(!("LoanID" in escrowObj) && !("Escrow" in loanObj) && !("EscrowID" in loanObj),
      "neither object references the other on-chain");
    console.log(`  Loan object exposes Data field: ${"Data" in loanObj} (mapping kept in appState regardless)`);

    printLinks();

    // Friction to capture (plan 4.2).
    logFriction({
      phase: "4.2", surface: "protocol", feature: "escrow", tx_type: "LoanSet",
      note: "No native escrow<->loan binding: LoanSet does not verify the escrow and the Loan object carries no escrow reference. The application must read the validated escrow and gate origination itself; the mapping lives in application state (and a LoanSet.Data breadcrumb), not on-chain.",
    });
    logFriction({
      phase: "4.2", surface: "protocol", feature: "escrow", tx_type: "EscrowCreate",
      note: `Collateral escrow Destination must be the broker owner, not the broker pseudo-account (its assets are protocol-governed and CoverAvailable would not rise). Loan object Data present: ${"Data" in loanObj}.`,
    });

    console.log("\nPhase 4.2 complete: application-verified collateral gate enforced before a loan with no on-chain escrow link.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ phase: "4.2", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
