// Phase 4.3 — Default and Collateral Claim
//
// Default a collateralized loan and claim the token collateral from escrow. The two
// are SEPARATE, non-atomic transactions: LoanManage default does not release the
// escrow, and escrow release cannot be gated on default. A crypto-Condition whose
// Fulfillment the broker reveals only on default approximates broker control, but this
// is application-enforced, not protocol-enforced.
//
// Independence: this phase builds its own collateral token, escrow, vault, broker with
// cover, and one short loan, then lets it default. It imports no other phase.
//
// Run:  node part-4/4.3_default_and_collateral_claim.mjs   (waits ~2-3 min for windows)

import { LoanManageFlags } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  waitUntilAfter,
  readVault,
  readLedgerEntry,
  logFriction,
} from "../lib/index.mjs";
import {
  assert,
  big,
  makeRecorder,
  createVault,
  vaultDeposit,
  createBroker,
  depositCover,
  originateLoan,
} from "../lib/lending.mjs";
import { MPTokenIssuanceCreateFlags as F, createMptIssuance, authorizeMpt, mptBalance } from "../lib/mpt.mjs";
import { makeCondition, createEscrow, readEscrow, escrowFinishTx } from "../lib/escrow.mjs";

const LSF_LOAN_DEFAULT = 0x00010000; // Loan ledger flag (ripple-binary-codec: lsfLoanDefault)
const COLLATERAL = "500";

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();
  const appState = {}; // escrow<->loan mapping lives here, not on-chain

  try {
    // Preconditions: issuer, lender, owner (vault + broker), borrower.
    const [issuer, lender, owner, borrower] = await fundAccounts(client, 4);
    console.log(`issuer=${issuer.address}\nlender=${lender.address}\nowner=${owner.address}\nborrower=${borrower.address}`);

    // Collateral MPT minted to the borrower; owner opted in to receive it on finish.
    const { hash: mptHash, issuanceId } = await createMptIssuance(client, issuer, {
      flags: F.tfMPTCanEscrow | F.tfMPTCanTransfer, assetScale: 0, maximumAmount: "1000000",
    });
    record("MPTokenIssuanceCreate (collateral)", mptHash);
    for (const acct of [borrower, owner]) await authorizeMpt(client, acct, issuanceId);
    await submitAndWait(client, {
      TransactionType: "Payment", Account: issuer.address, Destination: borrower.address,
      Amount: { mpt_issuance_id: issuanceId, value: "1000" },
    }, issuer);

    // XRP vault funded; broker with cover smaller than the loan (so a residual loss remains).
    const { hash: vaultHash, vaultId } = await createVault(client, owner);
    record("VaultCreate", vaultHash);
    record("VaultDeposit", (await vaultDeposit(client, lender, vaultId, "100000000")).hash); // 100 XRP
    const { hash: brokerHash, brokerId } = await createBroker(client, owner, vaultId, {
      coverRateMinimum: 10000, coverRateLiquidation: 100000, // 10% / 100%
    });
    record("LoanBrokerSet", brokerHash);
    record("LoanBrokerCoverDeposit", (await depositCover(client, owner, brokerId, "10000000")).hash); // 10 XRP

    // Collateral escrow: borrower -> owner, crypto-Condition (broker reveals the
    // Fulfillment only on default). FinishAfter is reached well before the default
    // window, so after default the broker can finish immediately.
    const base = (await client.request({ command: "ledger", ledger_index: "validated" })).result.ledger.close_time;
    const { condition, fulfillment } = makeCondition();
    const escrow = await createEscrow(client, borrower, {
      amount: { mpt_issuance_id: issuanceId, value: COLLATERAL },
      destination: owner, finishAfter: base + 8, cancelAfter: base + 7200, condition,
    });
    record("EscrowCreate (collateral)", escrow.hash);

    // One short loan; keep the escrow<->loan mapping in application state.
    const loan0 = await originateLoan(client, {
      borrower, owner, brokerId, principal: "40000000", // 40 XRP
      terms: { PaymentInterval: 60, PaymentTotal: 1, GracePeriod: 60 },
    });
    record("LoanSet", loan0.hash);
    const loanId = loan0.loanId;
    appState[loanId] = { escrowOwner: borrower.address, escrowSequence: escrow.sequence };
    let loan = await readLedgerEntry(client, loanId);
    const graceEnd = loan.NextPaymentDueDate + loan.GracePeriod;
    console.log(`  LoanID=${loanId} graceEnd=${graceEnd}  escrowSeq=${escrow.sequence}`);

    // Step 1+2: wait strictly beyond grace, then LoanManage default.
    console.log(`  waiting until ledger time > graceEnd (${graceEnd}) ...`);
    await waitUntilAfter(client, graceEnd);
    const vaultBefore = await readVault(client, vaultId);
    const brokerBefore = await readLedgerEntry(client, brokerId);
    const dflt = await submitAndWait(client, {
      TransactionType: "LoanManage", Account: owner.address, LoanID: loanId, Flags: LoanManageFlags.tfLoanDefault,
    }, owner);
    record("LoanManage default", dflt.hash);
    loan = await readLedgerEntry(client, loanId);
    const vaultAfter = await readVault(client, vaultId);
    const brokerAfter = await readLedgerEntry(client, brokerId);

    const defaultCovered = big(brokerBefore.CoverAvailable) - big(brokerAfter.CoverAvailable);
    const realizedLoss = big(vaultBefore.AssetsTotal) - big(vaultAfter.AssetsTotal);
    const defaultAmount = big(brokerBefore.DebtTotal) - big(brokerAfter.DebtTotal);
    console.log(`  lsfLoanDefault set=${(loan.Flags & LSF_LOAN_DEFAULT) !== 0}` +
      ` DefaultCovered=${defaultCovered} realizedLoss=${realizedLoss} DefaultAmount=${defaultAmount}`);
    assert((loan.Flags & LSF_LOAN_DEFAULT) !== 0, "lsfLoanDefault set after default");
    assert(defaultCovered > 0n, "CoverAvailable dropped by DefaultCovered (cover liquidated to vault)");
    assert(realizedLoss > 0n, "residual is a realized vault loss (AssetsTotal dropped)");
    const covPlusLoss = defaultCovered + realizedLoss;
    const diff = defaultAmount > covPlusLoss ? defaultAmount - covPlusLoss : covPlusLoss - defaultAmount;
    assert(diff <= 1n, "conservation: DefaultAmount == DefaultCovered + realized loss (±1 drop)");

    // Non-atomicity proof: the loan is defaulted but the collateral is STILL escrowed.
    const escrowMid = await readEscrow(client, borrower, escrow.sequence);
    const ownerCollBefore = await mptBalance(client, owner, issuanceId);
    assert(escrowMid !== null, "collateral still escrowed after default (no automatic release)");
    assert(ownerCollBefore === "0", "owner has not received collateral from the default alone");
    console.log("  gap confirmed: loan defaulted, collateral still locked in escrow");

    // Independence / failed-finish control: finishing with a WRONG fulfillment fails,
    // regardless of the loan being in default. Recovery is not guaranteed by default.
    const wrongFulfillment = makeCondition().fulfillment;
    const badFinish = await submitExpectingFailure(client,
      escrowFinishTx(owner, { owner: borrower, offerSequence: escrow.sequence, condition, fulfillment: wrongFulfillment }), owner);
    console.log(`  EscrowFinish with wrong Fulfillment -> ${badFinish.code}`);
    assert(badFinish.code === "tecCRYPTOCONDITION_ERROR",
      `finish with wrong fulfillment rejected tecCRYPTOCONDITION_ERROR (${badFinish.code})`);

    // Step 3: broker reveals the Fulfillment and claims the collateral to owner.
    const finish = await submitAndWait(client,
      escrowFinishTx(owner, { owner: borrower, offerSequence: escrow.sequence, condition, fulfillment }), owner);
    record("EscrowFinish (collateral claim)", finish.hash);
    const ownerCollAfter = await mptBalance(client, owner, issuanceId);
    const escrowGone = await readEscrow(client, borrower, escrow.sequence);
    console.log(`  owner collateral ${ownerCollBefore} -> ${ownerCollAfter}; escrow present=${escrowGone !== null}`);
    assert(ownerCollAfter === COLLATERAL, "collateral delivered to owner on EscrowFinish");
    assert(escrowGone === null, "escrow object removed after finish");

    printLinks();

    // Friction to capture (plan 4.3).
    logFriction({
      phase: "4.3", surface: "protocol", feature: "escrow", tx_type: "LoanManage",
      note: "Default and recovery are non-atomic: LoanManage default liquidates first-loss cover to the vault but does NOT release the collateral escrow. Recovery is a separate EscrowFinish the application must coordinate.",
    });
    logFriction({
      phase: "4.3", surface: "protocol", feature: "escrow", tx_type: "EscrowFinish",
      note: `Escrow release cannot be gated on default: once FinishAfter passes, anyone can finish regardless of loan status. A crypto-Condition whose Fulfillment the broker reveals only on default approximates control (wrong fulfillment -> ${badFinish.code}), but it is application-enforced, not protocol-enforced.`,
    });

    console.log("\nPhase 4.3 complete: loan defaulted (first-loss cover liquidated), collateral claimed via a separate EscrowFinish.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ phase: "4.3", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
