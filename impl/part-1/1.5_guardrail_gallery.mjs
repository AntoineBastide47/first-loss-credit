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
// Independence: every case builds its own vault/broker/loan. Cases share no state.
//
// Run:  node part-1/1.5_guardrail_gallery.mjs   (case E waits ~60s for the overdue window)

import { VaultWithdrawalPolicy, LoanPayFlags } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  submitSignedExpectingFailure,
  signLoanSetCounterparty,
  roundUpToAssetUnit,
  waitUntilAfter,
  readVault,
  readLedgerEntry,
  explorer,
  logFriction,
} from "../lib/index.mjs";

const XRP = { currency: "XRP" };
const results = [];
function created(meta, entryType) {
  for (const n of meta.AffectedNodes || []) {
    if (n.CreatedNode?.LedgerEntryType === entryType) return n.CreatedNode.LedgerIndex;
  }
  throw new Error(`no created ${entryType} in metadata`);
}
// Truncate a high-precision decimal string DOWN to an integer base-unit string.
const truncate = (v) => String(v).split(".")[0];

// Build a funded vault + broker (+ optional cover) owned by `owner`. Returns ids.
async function buildSubstrate(client, { owner, lender, deposit, assetsMaximum, rates, debtMaximum, cover }) {
  const vcTx = {
    TransactionType: "VaultCreate", Account: owner.address, Asset: XRP,
    WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
  };
  if (assetsMaximum) vcTx.AssetsMaximum = assetsMaximum;
  const vc = await submitAndWait(client, vcTx, owner);
  const vaultId = created(vc.meta, "Vault");
  if (deposit) {
    await submitAndWait(client, {
      TransactionType: "VaultDeposit", Account: lender.address, VaultID: vaultId, Amount: deposit,
    }, lender);
  }
  const bs = await submitAndWait(client, {
    TransactionType: "LoanBrokerSet", Account: owner.address, VaultID: vaultId,
    ManagementFeeRate: 0, DebtMaximum: debtMaximum ?? "1000000000",
    CoverRateMinimum: rates?.min ?? 10000, CoverRateLiquidation: rates?.liq ?? 20000,
  }, owner);
  const brokerId = created(bs.meta, "LoanBroker");
  if (cover) {
    await submitAndWait(client, {
      TransactionType: "LoanBrokerCoverDeposit", Account: owner.address, LoanBrokerID: brokerId, Amount: cover,
    }, owner);
  }
  return { vaultId, brokerId };
}

async function originate(client, { borrower, owner, brokerId, principal, terms = {} }) {
  const tx = await client.autofill({
    TransactionType: "LoanSet", Account: borrower.address, Counterparty: owner.address,
    LoanBrokerID: brokerId, PrincipalRequested: principal,
    InterestRate: 100000, PaymentInterval: 60, PaymentTotal: 2, GracePeriod: 60, ...terms,
  });
  const res = await client.submitAndWait(signLoanSetCounterparty(borrower.sign(tx).tx_blob, owner).tx_blob);
  const code = res.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`originate LoanSet failed: ${code}`);
  return created(res.result.meta, "Loan");
}

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
    // ---- A. Insufficient liquidity on VaultWithdraw ----
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { vaultId, brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "100000000", cover: "50000000",
      });
      await originate(client, { borrower, owner, brokerId, principal: "80000000" }); // draws to ~20 XRP avail
      const v = await readVault(client, vaultId);
      const avail = BigInt(v.AssetsAvailable);
      const tooMuch = (avail + 30000000n).toString(); // 30 XRP over available, lender has 100 XRP shares
      const fail = await submitExpectingFailure(client, {
        TransactionType: "VaultWithdraw", Account: lender.address, VaultID: vaultId, Amount: tooMuch,
      }, lender);
      const ok = await submitAndWait(client, {
        TransactionType: "VaultWithdraw", Account: lender.address, VaultID: vaultId, Amount: "5000000",
      }, lender); // 5 XRP <= available
      check("A VaultWithdraw liquidity", fail.code, "tecINSUFFICIENT_FUNDS", ok.hash);
    }

    // ---- B. Insufficient liquidity on LoanSet ----
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "10000000", cover: "50000000", // only 10 XRP liquid
      });
      const fail = await submitSignedExpectingFailure(client,
        await loanSetBlobExpectFail(client, borrower, owner, brokerId, "40000000"),
      );
      const okLoan = await originate(client, { borrower, owner, brokerId, principal: "5000000" }); // <= 10 avail
      check("B LoanSet liquidity", fail.code, "tecINSUFFICIENT_FUNDS", okLoan);
    }

    // ---- C. Cover below minimum blocks a new loan ----
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "100000000", cover: "2000000", // 2 XRP cover
        rates: { min: 50000, liq: 20000 }, // 50% minimum -> 40 XRP loan needs 20 XRP cover
      });
      const fail = await submitSignedExpectingFailure(client,
        await loanSetBlobExpectFail(client, borrower, owner, brokerId, "40000000"),
      );
      // Positive control: top up cover to >= 20 XRP, then the same loan succeeds.
      await submitAndWait(client, {
        TransactionType: "LoanBrokerCoverDeposit", Account: owner.address, LoanBrokerID: brokerId, Amount: "20000000",
      }, owner);
      const okLoan = await originate(client, { borrower, owner, brokerId, principal: "40000000" });
      check("C cover-minimum blocks loan", fail.code, "tecINSUFFICIENT_FUNDS", okLoan);
    }

    // ---- D. Deposit over the vault cap ----
    {
      const [owner, lender] = await fundAccounts(client, 2);
      const { vaultId } = await buildSubstrate(client, {
        owner, lender, assetsMaximum: "50000000", // cap 50 XRP
      });
      const fail = await submitExpectingFailure(client, {
        TransactionType: "VaultDeposit", Account: lender.address, VaultID: vaultId, Amount: "60000000",
      }, lender);
      const ok = await submitAndWait(client, {
        TransactionType: "VaultDeposit", Account: lender.address, VaultID: vaultId, Amount: "40000000",
      }, lender);
      check("D deposit over cap", fail.code, "tecLIMIT_EXCEEDED", ok.hash);
    }

    // ---- G. Debt cap exceeded ----
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "100000000", cover: "50000000", debtMaximum: "10000000", // 10 XRP cap
      });
      const fail = await submitSignedExpectingFailure(client,
        await loanSetBlobExpectFail(client, borrower, owner, brokerId, "40000000"),
      );
      const okLoan = await originate(client, { borrower, owner, brokerId, principal: "5000000" }); // <= 10 cap
      check("G debt cap exceeded", fail.code, "tecLIMIT_EXCEEDED", okLoan);
    }

    // ---- H. Cover withdrawal below the minimum (same family as 1.2) ----
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

    // ---- F. On-time payment below the required amount ----
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "100000000", cover: "50000000",
      });
      const loanId = await originate(client, { borrower, owner, brokerId, principal: "40000000" });
      const loan = await readLedgerEntry(client, loanId);
      const up = roundUpToAssetUnit(loan.PeriodicPayment, XRP); // full periodic, rounded UP -> ok
      // Note: truncating PeriodicPayment by its sub-drop fraction is ACCEPTED on this build;
      // tecINSUFFICIENT_PAYMENT needs a real shortfall, so pay clearly below the period amount.
      const short = (BigInt(truncate(loan.PeriodicPayment)) / 2n).toString();
      const fail = await submitExpectingFailure(client, {
        TransactionType: "LoanPay", Account: borrower.address, LoanID: loanId, Amount: short,
      }, borrower);
      const ok = await submitAndWait(client, {
        TransactionType: "LoanPay", Account: borrower.address, LoanID: loanId, Amount: up,
      }, borrower);
      check("F on-time payment below required", fail.code, "tecINSUFFICIENT_PAYMENT", ok.hash);
    }

    // ---- E. Late payment without the late flag (must wait for overdue) ----
    {
      const [owner, lender, borrower] = await fundAccounts(client, 3);
      const { brokerId } = await buildSubstrate(client, {
        owner, lender, deposit: "100000000", cover: "50000000",
      });
      const loanId = await originate(client, { borrower, owner, brokerId, principal: "40000000" });
      let loan = await readLedgerEntry(client, loanId);
      console.log(`  E: waiting until overdue (NextPaymentDueDate=${loan.NextPaymentDueDate}) ...`);
      await waitUntilAfter(client, loan.NextPaymentDueDate);
      loan = await readLedgerEntry(client, loanId);
      const amount = roundUpToAssetUnit(loan.PeriodicPayment, XRP);
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

// Build a first-party-signed + counterparty-signed LoanSet blob for a case where the
// LoanSet itself is expected to FAIL at submit (liquidity/cover/debt-cap checks).
async function loanSetBlobExpectFail(client, borrower, owner, brokerId, principal) {
  const tx = await client.autofill({
    TransactionType: "LoanSet", Account: borrower.address, Counterparty: owner.address,
    LoanBrokerID: brokerId, PrincipalRequested: principal,
    InterestRate: 100000, PaymentInterval: 60, PaymentTotal: 2, GracePeriod: 60,
  });
  return signLoanSetCounterparty(borrower.sign(tx).tx_blob, owner).tx_blob;
}

main().catch((e) => {
  logFriction({ phase: "1.5", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
