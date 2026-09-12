// Phase 1.5 — Guardrail Gallery
//
// Reproduce each protocol guardrail rejection required by the hackathon bar, each as
// an isolated case where all other preconditions pass so the failing reason is
// unambiguous. Every case pairs the failing tx with a positive control that succeeds
// once the single blocking condition is removed.
//
// Cases: A liquidity on VaultWithdraw, B liquidity on LoanSet, C cover-below-minimum
// blocks a new loan, D deposit over the vault cap, E late payment without the late
// flag, F on-time payment below the required amount, G debt cap exceeded, H cover
// withdraw below the minimum.
//
// Independence: every case builds its own substrate via the shared lib. It imports
// no other phase and reads no phase's state; cases share no runtime state.
//
// Run:  node part-1/1.5_guardrail_gallery.mjs   (case E waits ~60s for the overdue window)

import { LoanPayFlags } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  submitSignedExpectingFailure,
  roundUpToAssetUnit,
  waitUntilAfter,
  readVault,
  readLedgerEntry,
  logFriction,
} from "../lib/index.mjs";
import {
  createVault,
  vaultDeposit,
  createBroker,
  depositCover,
  originateLoan,
  signedLoanSet,
} from "../lib/lending.mjs";

const results = [];
const CASE_TERMS = { PaymentTotal: 2 }; // multi-payment so one loan spans the cases' needs
const truncate = (v) => String(v).split(".")[0];

// Build a funded vault + broker (+ optional cover) from case parameters, via the lib.
async function buildSubstrate(client, { owner, lender, deposit, assetsMaximum, rates, debtMaximum, cover }) {
  const { vaultId } = await createVault(client, owner, { assetsMaximum });
  if (deposit) await vaultDeposit(client, lender, vaultId, deposit);
  const { brokerId } = await createBroker(client, owner, vaultId, {
    debtMaximum, coverRateMinimum: rates?.min, coverRateLiquidation: rates?.liq,
  });
  if (cover) await depositCover(client, owner, brokerId, cover);
  return { vaultId, brokerId };
}

const originate = async (client, args) =>
  (await originateLoan(client, { ...args, terms: { ...CASE_TERMS, ...args.terms } })).loanId;

const loanSetBlobExpectFail = (client, borrower, owner, brokerId, principal) =>
  signedLoanSet(client, { borrower, owner, brokerId, principal, terms: CASE_TERMS });

// Record a case: the expected failing code + a positive control that must succeed.
function check(name, failCode, expected, okHash) {
  const pass = failCode === expected && !!okHash;
  results.push({ name, expected, got: failCode, okHash, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}: fail=${failCode} (expected ${expected}); control ${okHash ? "tesSUCCESS" : "MISSING"}`);
  if (!pass) throw new Error(`case ${name}: expected ${expected}, got ${failCode}; control ok=${!!okHash}`);
}

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}\n`);
  try {
    // A. Insufficient liquidity on VaultWithdraw.
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { vaultId, brokerId } = await buildSubstrate(client, { owner, lender, deposit: "100000000", cover: "50000000" });
      await originate(client, { borrower, owner, brokerId, principal: "80000000" }); // draws to ~20 XRP avail
      const avail = BigInt((await readVault(client, vaultId)).AssetsAvailable);
      const tooMuch = (avail + 30000000n).toString(); // over available; lender holds 100 XRP shares
      const fail = await submitExpectingFailure(client, {
        TransactionType: "VaultWithdraw", Account: lender.address, VaultID: vaultId, Amount: tooMuch,
      }, lender);
      const ok = await submitAndWait(client, {
        TransactionType: "VaultWithdraw", Account: lender.address, VaultID: vaultId, Amount: "5000000",
      }, lender); // 5 XRP <= available
      check("A VaultWithdraw liquidity", fail.code, "tecINSUFFICIENT_FUNDS", ok.hash);
    }

    // B. Insufficient liquidity on LoanSet.
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, { owner, lender, deposit: "10000000", cover: "50000000" }); // 10 XRP liquid
      const fail = await submitSignedExpectingFailure(client,
        await loanSetBlobExpectFail(client, borrower, owner, brokerId, "40000000"));
      const okLoan = await originate(client, { borrower, owner, brokerId, principal: "5000000" }); // <= 10 avail
      check("B LoanSet liquidity", fail.code, "tecINSUFFICIENT_FUNDS", okLoan);
    }

    // C. Cover below minimum blocks a new loan.
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "100000000", cover: "2000000", rates: { min: 50000, liq: 20000 },
      }); // 50% min -> 40 XRP loan needs 20 XRP cover, only 2 XRP posted
      const fail = await submitSignedExpectingFailure(client,
        await loanSetBlobExpectFail(client, borrower, owner, brokerId, "40000000"));
      await depositCover(client, owner, brokerId, "20000000"); // top up, then same loan succeeds
      const okLoan = await originate(client, { borrower, owner, brokerId, principal: "40000000" });
      check("C cover-minimum blocks loan", fail.code, "tecINSUFFICIENT_FUNDS", okLoan);
    }

    // D. Deposit over the vault cap.
    {
      const [owner, lender] = await fundAccounts(client, 2);
      const { vaultId } = await buildSubstrate(client, { owner, lender, assetsMaximum: "50000000" }); // cap 50 XRP
      const fail = await submitExpectingFailure(client, {
        TransactionType: "VaultDeposit", Account: lender.address, VaultID: vaultId, Amount: "60000000",
      }, lender);
      const ok = await submitAndWait(client, {
        TransactionType: "VaultDeposit", Account: lender.address, VaultID: vaultId, Amount: "40000000",
      }, lender);
      check("D deposit over cap", fail.code, "tecLIMIT_EXCEEDED", ok.hash);
    }

    // G. Debt cap exceeded.
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "100000000", cover: "50000000", debtMaximum: "10000000", // 10 XRP cap
      });
      const fail = await submitSignedExpectingFailure(client,
        await loanSetBlobExpectFail(client, borrower, owner, brokerId, "40000000"));
      const okLoan = await originate(client, { borrower, owner, brokerId, principal: "5000000" }); // <= 10 cap
      check("G debt cap exceeded", fail.code, "tecLIMIT_EXCEEDED", okLoan);
    }

    // H. Cover withdrawal below the minimum (same family as 1.2).
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "100000000", cover: "30000000", rates: { min: 50000, liq: 20000 },
      });
      await originate(client, { borrower, owner, brokerId, principal: "40000000" }); // DebtTotal 40 -> min 20
      const b = await readLedgerEntry(client, brokerId);
      const slack = BigInt(b.CoverAvailable) - (BigInt(b.DebtTotal) * 50000n) / 100000n;
      const fail = await submitExpectingFailure(client, {
        TransactionType: "LoanBrokerCoverWithdraw", Account: owner.address, LoanBrokerID: brokerId,
        Amount: (slack + 1000000n).toString(),
      }, owner);
      const ok = await submitAndWait(client, {
        TransactionType: "LoanBrokerCoverWithdraw", Account: owner.address, LoanBrokerID: brokerId,
        Amount: (slack / 2n).toString(),
      }, owner);
      check("H cover-withdraw below minimum", fail.code, "tecINSUFFICIENT_FUNDS", ok.hash);
    }

    // F. On-time payment below the required amount.
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, { owner, lender, deposit: "100000000", cover: "50000000" });
      const loanId = await originate(client, { borrower, owner, brokerId, principal: "40000000" });
      const loan = await readLedgerEntry(client, loanId);
      const up = roundUpToAssetUnit(loan.PeriodicPayment); // full periodic, rounded UP -> ok
      // A sub-drop truncation is accepted on this build; tecINSUFFICIENT_PAYMENT needs a
      // real shortfall, so pay clearly below the period amount.
      const short = (BigInt(truncate(loan.PeriodicPayment)) / 2n).toString();
      const fail = await submitExpectingFailure(client, {
        TransactionType: "LoanPay", Account: borrower.address, LoanID: loanId, Amount: short,
      }, borrower);
      const ok = await submitAndWait(client, {
        TransactionType: "LoanPay", Account: borrower.address, LoanID: loanId, Amount: up,
      }, borrower);
      check("F on-time payment below required", fail.code, "tecINSUFFICIENT_PAYMENT", ok.hash);
    }

    // E. Late payment without the late flag (must wait for overdue).
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, { owner, lender, deposit: "100000000", cover: "50000000" });
      const loanId = await originate(client, { borrower, owner, brokerId, principal: "40000000" });
      let loan = await readLedgerEntry(client, loanId);
      console.log(`  E: waiting until overdue (NextPaymentDueDate=${loan.NextPaymentDueDate}) ...`);
      await waitUntilAfter(client, loan.NextPaymentDueDate);
      loan = await readLedgerEntry(client, loanId);
      const amount = roundUpToAssetUnit(loan.PeriodicPayment);
      const fail = await submitExpectingFailure(client, {
        TransactionType: "LoanPay", Account: borrower.address, LoanID: loanId, Amount: amount,
      }, borrower); // no tfLoanLatePayment -> tecEXPIRED
      const ok = await submitAndWait(client, {
        TransactionType: "LoanPay", Account: borrower.address, LoanID: loanId, Amount: amount,
        Flags: LoanPayFlags.tfLoanLatePayment,
      }, borrower);
      check("E late payment without late flag", fail.code, "tecEXPIRED", ok.hash);
    }

    const passed = results.filter((r) => r.pass).length;
    console.log(`\nGuardrail gallery: ${passed}/${results.length} cases passed (fail code + positive control).`);
    if (passed !== results.length) throw new Error("not all guardrail cases passed");
    console.log("Phase 1.5 complete: all protocol guardrails reproduced with positive controls.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ phase: "1.5", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
