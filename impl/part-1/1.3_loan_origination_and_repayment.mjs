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
// Independence: builds its own funded vault, broker with cover, and its loans.
//
// Run:  node part-1/1.3_loan_origination_and_repayment.mjs

import { VaultWithdrawalPolicy, LoanPayFlags } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  signLoanSetCounterparty,
  roundUpToAssetUnit,
  readVault,
  readLedgerEntry,
  explorer,
  logFriction,
  dropsToXrp,
} from "../lib/index.mjs";

const XRP = { currency: "XRP" };
const links = [];
const record = (label, hash) => {
  links.push(`  ${label}: ${explorer(hash)}`);
  console.log(`✓ ${label}  ${hash}`);
};
function created(meta, entryType) {
  for (const n of meta.AffectedNodes || []) {
    if (n.CreatedNode?.LedgerEntryType === entryType) return n.CreatedNode.LedgerIndex;
  }
  throw new Error(`no created ${entryType} in metadata`);
}
// Signed XRP balance change of `account` in this tx (after - before), in drops.
function balanceChange(meta, account) {
  for (const n of meta.AffectedNodes || []) {
    const m = n.ModifiedNode || n.CreatedNode;
    const ff = m?.FinalFields || m?.NewFields;
    if (m?.LedgerEntryType === "AccountRoot" && ff?.Account === account) {
      const before = BigInt(m.PreviousFields?.Balance ?? ff.Balance);
      const after = BigInt(ff.Balance);
      return after - before;
    }
  }
  return 0n;
}
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  assert ok: ${msg}`);
}

// Originate a loan: borrower initiates, owner (broker) co-signs. Returns { loanId, meta }.
async function originate(client, { borrower, owner, brokerId, terms }) {
  const tx = await client.autofill({
    TransactionType: "LoanSet",
    Account: borrower.address,
    Counterparty: owner.address,
    LoanBrokerID: brokerId,
    ...terms,
  });
  const signed = borrower.sign(tx);
  const cosigned = signLoanSetCounterparty(signed.tx_blob, owner);
  const res = await client.submitAndWait(cosigned.tx_blob);
  const code = res.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`LoanSet failed: ${code}`);
  return { loanId: created(res.result.meta, "Loan"), meta: res.result.meta, hash: res.result.hash };
}

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);

  try {
    const [owner, lender, borrower] = await fundAccounts(client, 3);
    console.log(`owner=${owner.address}\nlender=${lender.address}\nborrower=${borrower.address}`);

    // Funded vault owned by owner.
    const vc = await submitAndWait(client, {
      TransactionType: "VaultCreate", Account: owner.address, Asset: XRP,
      WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
    }, owner);
    record("VaultCreate", vc.hash);
    const vaultId = created(vc.meta, "Vault");
    record("VaultDeposit", (await submitAndWait(client, {
      TransactionType: "VaultDeposit", Account: lender.address, VaultID: vaultId, Amount: "200000000",
    }, lender)).hash); // 200 XRP

    // Broker with low cover minimum and generous cover so origination is not gated.
    const bs = await submitAndWait(client, {
      TransactionType: "LoanBrokerSet", Account: owner.address, VaultID: vaultId,
      ManagementFeeRate: 0, DebtMaximum: "1000000000",
      CoverRateMinimum: 10000, CoverRateLiquidation: 20000, // 10% / 20%
    }, owner);
    record("LoanBrokerSet", bs.hash);
    const brokerId = created(bs.meta, "LoanBroker");
    record("LoanBrokerCoverDeposit", (await submitAndWait(client, {
      TransactionType: "LoanBrokerCoverDeposit", Account: owner.address, LoanBrokerID: brokerId, Amount: "50000000",
    }, owner)).hash); // 50 XRP cover

    // ================= Loan A: origination accounting + payment + early settlement =====
    console.log("\n--- Loan A (PaymentTotal=3): origination + regular pay + early full pay ---");
    const originationFee = "1000000"; // 1 XRP
    const principalA = "30000000"; // 30 XRP
    const vaultBefore = await readVault(client, vaultId);
    const brokerBefore = await readLedgerEntry(client, brokerId);
    const a = await originate(client, {
      borrower, owner, brokerId,
      terms: {
        PrincipalRequested: principalA,
        InterestRate: 100000, // 10% annualized
        PaymentInterval: 3600, PaymentTotal: 3, GracePeriod: 300,
        LoanOriginationFee: originationFee,
      },
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

    assert(
      BigInt(vaultAfterOrig.AssetsAvailable) === BigInt(vaultBefore.AssetsAvailable) - BigInt(principalA),
      "AssetsAvailable -= PrincipalRequested at origination",
    );
    assert(
      vaultAfterOrig.AssetsTotal === vaultBefore.AssetsTotal,
      "cash basis: AssetsTotal unchanged at origination (no accrual)",
    );
    assert(ownerGain === BigInt(originationFee), "owner received the LoanOriginationFee exactly");
    assert(loanA.PrincipalOutstanding === principalA, "loan PrincipalOutstanding == principal");
    assert(loanA.PaymentRemaining === 3, "PaymentRemaining == PaymentTotal");
    assert(BigInt(brokerAfterOrig.DebtTotal) >= BigInt(principalA), "DebtTotal rose by at least principal");

    // Regular payment #1 (PaymentRemaining 3 -> 2).
    const payA1Amount = roundUpToAssetUnit(loanA.PeriodicPayment, XRP);
    const availBeforePay = BigInt(vaultAfterOrig.AssetsAvailable);
    const pay1 = await submitAndWait(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: a.loanId, Amount: payA1Amount,
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
    const payoff = roundUpToAssetUnit(loanAAfterPay.TotalValueOutstanding, XRP);
    const full = await submitAndWait(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: a.loanId,
      Amount: payoff, Flags: LoanPayFlags.tfLoanFullPayment,
    }, borrower);
    record("LoanPay A full (early)", full.hash);
    console.log(`  early full payment tesSUCCESS with tfLoanFullPayment at PaymentRemaining=2`);

    // Negative control B: pay the already-settled loan A again.
    const payClosed = await submitExpectingFailure(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: a.loanId, Amount: "1000000",
    }, borrower);
    console.log(`  pay already-settled loan -> ${payClosed.code}`);
    assert(
      payClosed.code === "tecKILLED" || payClosed.code === "tecNO_ENTRY",
      `paying a settled loan is rejected (${payClosed.code})`,
    );

    // ================= Loan B: tfLoanFullPayment on the final payment =================
    console.log("\n--- Loan B (PaymentTotal=1): tfLoanFullPayment on final payment -> tecKILLED ---");
    const b = await originate(client, {
      borrower, owner, brokerId,
      terms: {
        PrincipalRequested: "10000000", // 10 XRP
        InterestRate: 100000, PaymentInterval: 3600, PaymentTotal: 1, GracePeriod: 300,
      },
    });
    record("LoanSet B", b.hash);
    const loanB = await readLedgerEntry(client, b.loanId);
    assert(loanB.PaymentRemaining === 1, "loan B PaymentRemaining == 1 (final payment)");

    // Negative control A: tfLoanFullPayment on the final payment -> tecKILLED.
    const payoffB = roundUpToAssetUnit(loanB.TotalValueOutstanding, XRP);
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

    console.log("\nExplorer links:\n" + links.join("\n"));
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
