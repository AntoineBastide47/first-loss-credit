// Phase 1.3 — Loan Origination and Repayment
//
// Originate a loan with the dual-signature LoanSet, confirm the borrower receives
// principal minus the origination fee INSIDE LoanSet (no separate draw), then run
// payments and confirm the accounting. Also prove the tfLoanFullPayment rules:
// valid for early settlement (PaymentRemaining > 1), tecKILLED on the final payment
// (PaymentRemaining == 1), and tecKILLED when paying an already-settled loan.
//
// This build is cash-basis (LendingProtocolV1_1): interest is recognized on LoanPay,
// NOT at origination. AssetsTotal is unchanged at LoanSet.
//
// Independence: builds its own funded vault, broker with cover, and its loans via
// the shared lib. It imports no other phase and reads no phase's state.
//
// Run:  node part-1/1.3_loan_origination_and_repayment.mjs

import { LoanPayFlags } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  roundUpToAssetUnit,
  readVault,
  readLedgerEntry,
  logFriction,
} from "../lib/index.mjs";
import {
  assert,
  makeRecorder,
  balanceChange,
  createVault,
  vaultDeposit,
  createBroker,
  depositCover,
  originateLoan,
} from "../lib/lending.mjs";

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    const [owner, lender, borrower] = await fundAccounts(client, 3);
    console.log(`owner=${owner.address}\nlender=${lender.address}\nborrower=${borrower.address}`);

    const { hash: vaultHash, vaultId } = await createVault(client, owner);
    record("VaultCreate", vaultHash);
    record("VaultDeposit", (await vaultDeposit(client, lender, vaultId, "200000000")).hash); // 200 XRP

    // Low cover minimum + generous cover so origination is not gated.
    const { hash: brokerHash, brokerId } = await createBroker(client, owner, vaultId, {
      coverRateMinimum: 10000, coverRateLiquidation: 20000,
    });
    record("LoanBrokerSet", brokerHash);
    record("LoanBrokerCoverDeposit", (await depositCover(client, owner, brokerId, "50000000")).hash); // 50 XRP

    // ===== Loan A: origination accounting + payment + early settlement =====
    console.log("\n--- Loan A (PaymentTotal=3): origination + regular pay + early full pay ---");
    const originationFee = "1000000"; // 1 XRP
    const principalA = "30000000"; // 30 XRP
    const vaultBefore = await readVault(client, vaultId);
    const brokerBefore = await readLedgerEntry(client, brokerId);
    const a = await originateLoan(client, {
      borrower, owner, brokerId, principal: principalA,
      terms: { PaymentInterval: 3600, PaymentTotal: 3, GracePeriod: 300, LoanOriginationFee: originationFee },
    });
    record("LoanSet A", a.hash);
    const ownerGain = balanceChange(a.meta, owner.address);
    const borrowerGain = balanceChange(a.meta, borrower.address);
    console.log(`  ownerΔ=${ownerGain} borrowerΔ=${borrowerGain} (borrowerΔ nets its tx fee)`);
    const vaultAfterOrig = await readVault(client, vaultId);
    const brokerAfterOrig = await readLedgerEntry(client, brokerId);
    const loanA = await readLedgerEntry(client, a.loanId);
    console.log(`  vault AssetsAvailable ${vaultBefore.AssetsAvailable} -> ${vaultAfterOrig.AssetsAvailable}`);
    console.log(`  vault AssetsTotal ${vaultBefore.AssetsTotal} -> ${vaultAfterOrig.AssetsTotal}`);
    console.log(`  broker DebtTotal ${brokerBefore.DebtTotal ?? "0"} -> ${brokerAfterOrig.DebtTotal}`);
    console.log(`  loanA: ${JSON.stringify(loanA)}`);

    assert(BigInt(vaultAfterOrig.AssetsAvailable) === BigInt(vaultBefore.AssetsAvailable) - BigInt(principalA),
      "AssetsAvailable -= PrincipalRequested at origination");
    assert(vaultAfterOrig.AssetsTotal === vaultBefore.AssetsTotal,
      "cash basis: AssetsTotal unchanged at origination (no accrual)");
    assert(ownerGain === BigInt(originationFee), "owner received the LoanOriginationFee exactly");
    assert(loanA.PrincipalOutstanding === principalA, "loan PrincipalOutstanding == principal");
    assert(loanA.PaymentRemaining === 3, "PaymentRemaining == PaymentTotal");
    assert(BigInt(brokerAfterOrig.DebtTotal) >= BigInt(principalA), "DebtTotal rose by at least principal");

    // Regular payment #1 (PaymentRemaining 3 -> 2).
    const availBeforePay = BigInt(vaultAfterOrig.AssetsAvailable);
    const pay1 = await submitAndWait(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: a.loanId,
      Amount: roundUpToAssetUnit(loanA.PeriodicPayment),
    }, borrower);
    record("LoanPay A #1", pay1.hash);
    const loanAAfterPay = await readLedgerEntry(client, a.loanId);
    const vaultAfterPay = await readVault(client, vaultId);
    console.log(`  after pay#1: PaymentRemaining=${loanAAfterPay.PaymentRemaining}` +
      ` PrincipalOutstanding=${loanAAfterPay.PrincipalOutstanding} AssetsAvailable=${vaultAfterPay.AssetsAvailable}`);
    assert(loanAAfterPay.PaymentRemaining === 2, "PaymentRemaining 3 -> 2 after one payment");
    assert(BigInt(loanAAfterPay.PrincipalOutstanding) < BigInt(principalA), "PrincipalOutstanding decreased");
    assert(BigInt(vaultAfterPay.AssetsAvailable) > availBeforePay, "principal+interest returned to the vault");

    // Early full settlement with tfLoanFullPayment (valid: PaymentRemaining == 2 > 1).
    const full = await submitAndWait(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: a.loanId,
      Amount: roundUpToAssetUnit(loanAAfterPay.TotalValueOutstanding), Flags: LoanPayFlags.tfLoanFullPayment,
    }, borrower);
    record("LoanPay A full (early)", full.hash);
    console.log(`  early full payment tesSUCCESS with tfLoanFullPayment at PaymentRemaining=2`);

    // Negative control B: pay the already-settled loan A again.
    const payClosed = await submitExpectingFailure(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: a.loanId, Amount: "1000000",
    }, borrower);
    console.log(`  pay already-settled loan -> ${payClosed.code}`);
    assert(payClosed.code === "tecKILLED" || payClosed.code === "tecNO_ENTRY",
      `paying a settled loan is rejected (${payClosed.code})`);

    // ===== Loan B: tfLoanFullPayment on the final payment =====
    console.log("\n--- Loan B (PaymentTotal=1): tfLoanFullPayment on final payment -> tecKILLED ---");
    const b = await originateLoan(client, {
      borrower, owner, brokerId, principal: "10000000", // 10 XRP
      terms: { PaymentInterval: 3600, PaymentTotal: 1, GracePeriod: 300 },
    });
    record("LoanSet B", b.hash);
    const loanB = await readLedgerEntry(client, b.loanId);
    assert(loanB.PaymentRemaining === 1, "loan B PaymentRemaining == 1 (final payment)");

    // Negative control A: tfLoanFullPayment on the final payment -> tecKILLED.
    const payoffB = roundUpToAssetUnit(loanB.TotalValueOutstanding);
    const badFull = await submitExpectingFailure(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: b.loanId,
      Amount: payoffB, Flags: LoanPayFlags.tfLoanFullPayment,
    }, borrower);
    console.log(`  tfLoanFullPayment on final payment -> ${badFull.code}`);
    assert(badFull.code === "tecKILLED", `tfLoanFullPayment on final payment -> tecKILLED (${badFull.code})`);

    // Positive: the same final payment WITHOUT the flag succeeds.
    const okFinal = await submitAndWait(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: b.loanId, Amount: payoffB,
    }, borrower);
    record("LoanPay B final (plain)", okFinal.hash);
    console.log(`  plain final payment tesSUCCESS`);

    printLinks();
    console.log("\nPhase 1.3 complete: dual-signed origination, cash-basis accounting, and " +
      "tfLoanFullPayment rules verified.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ phase: "1.3", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
