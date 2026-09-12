// Token Escrow Basics
//
// Lock an MPT in an escrow and release it (finish), and cancel a second escrow back to
// its owner. Learn the TokenEscrow mechanics the collateral flow needs:
//   - EscrowCreate has NO Data field: you cannot store a loan back-reference on the
//     escrow. Correlation is one-way (application state / LoanSet.Data) or a tx memo.
//   - MPT escrow between non-issuers needs BOTH tfMPTCanEscrow and tfMPTCanTransfer.
//   - EscrowFinish uses Owner + OfferSequence (the create's sequence); any account may
//     submit it; a crypto-condition, not the submitter, controls release.
//
// Independence: this flow issues its own MPT and builds one escrow it finishes and one
// it cancels. It imports no other flow.
//
// Run:  node src/escrow/token-basics.mjs

import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  waitUntilAfter,
  logFriction,
} from "../lib/index.mjs";
import { assert, makeRecorder } from "../lib/lending.mjs";
import { MPTokenIssuanceCreateFlags as F, createMptIssuance, authorizeMpt, readMptoken } from "../lib/mpt.mjs";
import { makeCondition, createEscrow, escrowFinishTx, escrowCancelTx } from "../lib/escrow.mjs";

const FINISH_AMT = "300";
const CANCEL_AMT = "200";

// MPToken balance model (verified): MPTAmount is the SPENDABLE balance; LockedAmount
// is the escrow-locked amount, still owned but not spendable. They are additive, so
// total owned = MPTAmount + LockedAmount.

/** Spendable MPT balance (BigInt), treating an absent token/field as 0. */
async function spendable(client, holder, issuanceId) {
  const tok = await readMptoken(client, holder, issuanceId);
  return tok ? BigInt(tok.MPTAmount ?? "0") : 0n;
}

/** Escrow-locked MPT amount on a holder's token (BigInt). */
async function locked(client, holder, issuanceId) {
  const tok = await readMptoken(client, holder, issuanceId);
  return tok ? BigInt(tok.LockedAmount ?? "0") : 0n;
}

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // Preconditions: issuer, owner (escrow creator), destination.
    const [issuer, owner, destination] = await fundAccounts(client, 3);
    console.log(`issuer=${issuer.address}\nowner=${owner.address}\ndestination=${destination.address}`);

    // Escrow-eligible MPT: CanEscrow + CanTransfer (both required for a non-issuer escrow).
    const { hash: mptHash, issuanceId } = await createMptIssuance(client, issuer, {
      flags: F.tfMPTCanEscrow | F.tfMPTCanTransfer, assetScale: 0, maximumAmount: "1000000",
    });
    record("MPTokenIssuanceCreate", mptHash);
    console.log(`  MPTokenIssuanceID=${issuanceId}`);

    // owner and destination opt in; mint to owner.
    for (const acct of [owner, destination]) await authorizeMpt(client, acct, issuanceId);
    await submitAndWait(client, {
      TransactionType: "Payment", Account: issuer.address, Destination: owner.address,
      Amount: { mpt_issuance_id: issuanceId, value: "1000" },
    }, issuer);
    const ownerStart = await spendable(client, owner, issuanceId);
    assert(ownerStart === 1000n, "owner starts with 1000 spendable MPT");

    // Timing base: current validated ledger close time (ripple-time seconds).
    const base = (await client.request({ command: "ledger", ledger_index: "validated" })).result.ledger.close_time;
    const finishAfter1 = base + 20, cancelAfter1 = base + 3600; // escrow #1: finish path
    const finishAfter2 = base + 10, cancelAfter2 = base + 30; // escrow #2: cancel path

    // Step 1: two EscrowCreates. #1 is conditioned (FinishAfter + Condition).
    const { condition, fulfillment } = makeCondition();
    const e1 = await createEscrow(client, owner, {
      amount: { mpt_issuance_id: issuanceId, value: FINISH_AMT },
      destination, finishAfter: finishAfter1, cancelAfter: cancelAfter1, condition,
    });
    record("EscrowCreate #1 (finish)", e1.hash);
    const e2 = await createEscrow(client, owner, {
      amount: { mpt_issuance_id: issuanceId, value: CANCEL_AMT },
      destination, finishAfter: finishAfter2, cancelAfter: cancelAfter2,
    });
    record("EscrowCreate #2 (cancel)", e2.hash);
    console.log(`  seq1=${e1.sequence} seq2=${e2.sequence}`);

    const ownerAfterCreate = await spendable(client, owner, issuanceId);
    const ownerLocked = await locked(client, owner, issuanceId);
    console.log(`  owner spendable ${ownerStart} -> ${ownerAfterCreate}, locked=${ownerLocked}`);
    assert(ownerAfterCreate === ownerStart - BigInt(FINISH_AMT) - BigInt(CANCEL_AMT),
      "owner spendable dropped by both escrowed amounts");
    assert(ownerLocked === BigInt(FINISH_AMT) + BigInt(CANCEL_AMT),
      "escrowed tokens held as LockedAmount on the owner token");

    // Negative control: finish #1 BEFORE FinishAfter (with the correct fulfillment) fails.
    const early = await submitExpectingFailure(client,
      escrowFinishTx(destination, { owner, offerSequence: e1.sequence, condition, fulfillment }), destination);
    console.log(`  EscrowFinish #1 before FinishAfter -> ${early.code}`);
    assert(early.code.startsWith("tec") || early.code.startsWith("tem"),
      `early finish rejected (${early.code})`);

    // Cross FinishAfter of #1.
    await waitUntilAfter(client, finishAfter1);

    // Negative control: finish #1 with a WRONG fulfillment fails.
    const wrong = makeCondition().fulfillment;
    const badFulfil = await submitExpectingFailure(client,
      escrowFinishTx(destination, { owner, offerSequence: e1.sequence, condition, fulfillment: wrong }), destination);
    console.log(`  EscrowFinish #1 wrong fulfillment -> ${badFulfil.code}`);
    assert(badFulfil.code.startsWith("tec") || badFulfil.code.startsWith("tem"),
      `wrong fulfillment rejected (${badFulfil.code})`);

    // Step 2: finish #1 with the correct fulfillment. Any account may submit; here the
    // destination does. Token moves to the destination.
    const finish = await submitAndWait(client,
      escrowFinishTx(destination, { owner, offerSequence: e1.sequence, condition, fulfillment }), destination);
    record("EscrowFinish #1", finish.hash);
    const destBal = await spendable(client, destination, issuanceId);
    console.log(`  destination spendable after finish = ${destBal}`);
    assert(destBal === BigInt(FINISH_AMT), "token delivered to destination on finish");

    // Step 3: cancel #2 after CancelAfter; token returns to owner.
    await waitUntilAfter(client, cancelAfter2);
    const cancel = await submitAndWait(client,
      escrowCancelTx(owner, { owner, offerSequence: e2.sequence }), owner);
    record("EscrowCancel #2", cancel.hash);
    const ownerFinal = await spendable(client, owner, issuanceId);
    console.log(`  owner spendable after cancel = ${ownerFinal}`);
    assert(ownerFinal === ownerAfterCreate + BigInt(CANCEL_AMT), "token returned to owner on cancel");

    printLinks();

    // Friction to capture.
    logFriction({
      flow: "escrow/token-basics", surface: "protocol", feature: "escrow", tx_type: "EscrowCreate",
      note: "EscrowCreate has no Data field, so an escrow cannot hold a loan back-reference. Loan correlation must be one-way (application state or LoanSet.Data) or a transaction memo.",
    });
    logFriction({
      flow: "escrow/token-basics", surface: "protocol", feature: "escrow", tx_type: "EscrowCreate",
      note: `Escrow release codes observed: early finish -> ${early.code}, wrong fulfillment -> ${badFulfil.code}. Locking permission differs by token: IOU needs the issuer account flag asfAllowTrustLineLocking; MPT needs tfMPTCanEscrow + tfMPTCanTransfer on the issuance.`,
    });

    console.log("\nComplete: MPT escrow locked, finished to destination, and a second escrow canceled back to owner.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ flow: "escrow/token-basics", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
