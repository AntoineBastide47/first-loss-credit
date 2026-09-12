// Phase 1.2 — Loan Broker and First-Loss Cover
//
// Create a loan broker on a funded vault, deposit first-loss cover, read the cover
// parameters, then prove the cover-minimum guardrail: a CoverWithdraw that would
// drop cover below DebtTotal * CoverRateMinimum while debt is outstanding is
// rejected (tecINSUFFICIENT_FUNDS). A smaller withdraw that keeps cover >= minimum
// succeeds.
//
// Independence: builds its own vault, broker, and one outstanding loan. Reads no
// other phase's runtime state. LoanSet co-signing reproduces the 1.3 procedure.
//
// Run:  node part-1/1.2_broker_and_first_loss_cover.mjs

import { VaultWithdrawalPolicy } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  signLoanSetCounterparty,
  readLedgerEntry,
  explorer,
  logFriction,
  dropsToXrp,
} from "../lib/index.mjs";

const XRP = { currency: "XRP" };
const COVER_RATE_DENOM = 100000n; // cover rates are 1/10 bps: 100% = 100000

const links = [];
const record = (label, hash) => {
  links.push(`  ${label}: ${explorer(hash)}`);
  console.log(`✓ ${label}  ${hash}`);
};
function createdIndex(meta, entryType) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === entryType) return c.LedgerIndex;
  }
  throw new Error(`no created ${entryType} in metadata`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  assert ok: ${msg}`);
}

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);

  try {
    // ---- Preconditions ----
    // brokerOwner must own the vault (LoanBrokerSet requires Account == Vault.Owner).
    const [brokerOwner, lender, borrower] = await fundAccounts(client, 3);
    console.log(
      `brokerOwner=${brokerOwner.address}\nlender=${lender.address}\nborrower=${borrower.address}`,
    );

    // Vault owned by brokerOwner, funded by the lender.
    const vaultCreate = await submitAndWait(
      client,
      {
        TransactionType: "VaultCreate",
        Account: brokerOwner.address,
        Asset: XRP,
        WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
      },
      brokerOwner,
    );
    record("VaultCreate", vaultCreate.hash);
    const vaultId = createdIndex(vaultCreate.meta, "Vault");

    const deposit = await submitAndWait(
      client,
      {
        TransactionType: "VaultDeposit",
        Account: lender.address,
        VaultID: vaultId,
        Amount: "100000000", // 100 XRP, enough to fund one loan
      },
      lender,
    );
    record("VaultDeposit", deposit.hash);

    // ---- Step 1: LoanBrokerSet with cover parameters ----
    const coverRateMinimum = 50000; // 50% of DebtTotal must be covered
    const coverRateLiquidation = 20000; // 20% of the minimum liquidated per default
    const brokerSet = await submitAndWait(
      client,
      {
        TransactionType: "LoanBrokerSet",
        Account: brokerOwner.address,
        VaultID: vaultId,
        ManagementFeeRate: 500, // 1/10 bps, range 0-10000 (5%)
        DebtMaximum: "1000000000", // 1000 XRP cap
        CoverRateMinimum: coverRateMinimum, // range 0-100000
        CoverRateLiquidation: coverRateLiquidation, // range 0-100000
      },
      brokerOwner,
    );
    record("LoanBrokerSet", brokerSet.hash);
    const brokerId = createdIndex(brokerSet.meta, "LoanBroker");
    let broker = await readLedgerEntry(client, brokerId);
    console.log(`  LoanBrokerID=${brokerId}`);
    console.log(
      `  broker: ManagementFeeRate=${broker.ManagementFeeRate}` +
        ` CoverRateMinimum=${broker.CoverRateMinimum} CoverRateLiquidation=${broker.CoverRateLiquidation}`,
    );
    assert(broker.CoverRateMinimum === coverRateMinimum, "CoverRateMinimum stored as set");
    assert(broker.CoverRateLiquidation === coverRateLiquidation, "CoverRateLiquidation stored as set");
    assert(broker.ManagementFeeRate === 500, "ManagementFeeRate stored as set");

    // ---- Step 2: LoanBrokerCoverDeposit ----
    const coverAmount = "30000000"; // 30 XRP first-loss cover
    const coverDeposit = await submitAndWait(
      client,
      {
        TransactionType: "LoanBrokerCoverDeposit",
        Account: brokerOwner.address,
        LoanBrokerID: brokerId,
        Amount: coverAmount,
      },
      brokerOwner,
    );
    record("LoanBrokerCoverDeposit", coverDeposit.hash);
    broker = await readLedgerEntry(client, brokerId);
    console.log(`  CoverAvailable=${broker.CoverAvailable} (deposited ${coverAmount})`);
    assert(broker.CoverAvailable === coverAmount, "CoverAvailable == deposit");

    // ---- Step 3: originate one loan so DebtTotal > 0 (reproduce 1.3 co-signing) ----
    const loanSetTx = await client.autofill({
      TransactionType: "LoanSet",
      Account: borrower.address,
      Counterparty: brokerOwner.address,
      LoanBrokerID: brokerId,
      PrincipalRequested: "40000000", // 40 XRP
      InterestRate: 100000, // 10% annualized (1/10 bps)
      PaymentInterval: 3600,
      PaymentTotal: 4,
      GracePeriod: 300,
    });
    const borrowerSigned = borrower.sign(loanSetTx);
    const cosigned = signLoanSetCounterparty(borrowerSigned.tx_blob, brokerOwner);
    const loanRes = await client.submitAndWait(cosigned.tx_blob);
    const loanCode = loanRes.result.meta?.TransactionResult;
    assert(loanCode === "tesSUCCESS", `LoanSet tesSUCCESS (got ${loanCode})`);
    record("LoanSet", loanRes.result.hash);

    broker = await readLedgerEntry(client, brokerId);
    const debtTotal = BigInt(broker.DebtTotal);
    const coverAvail = BigInt(broker.CoverAvailable);
    const requiredMin = (debtTotal * BigInt(coverRateMinimum)) / COVER_RATE_DENOM;
    const slack = coverAvail - requiredMin;
    console.log(
      `  DebtTotal=${debtTotal} CoverAvailable=${coverAvail}` +
        ` requiredMin=DebtTotal*${coverRateMinimum}/100000=${requiredMin} slack=${slack}`,
    );
    assert(debtTotal > 0n, "DebtTotal > 0 after origination");
    assert(slack > 2n, "cover slack exists for a meaningful test");

    // ---- Step 4: failing CoverWithdraw (drops cover below the minimum) ----
    // Withdraw more than the slack so CoverAvailable would fall below requiredMin.
    const failingAmount = (slack + 1000000n).toString(); // 1 XRP past the edge
    const failing = await submitExpectingFailure(
      client,
      {
        TransactionType: "LoanBrokerCoverWithdraw",
        Account: brokerOwner.address,
        LoanBrokerID: brokerId,
        Amount: failingAmount,
      },
      brokerOwner,
    );
    console.log(`  failing CoverWithdraw(${failingAmount}) -> ${failing.code}`);
    assert(
      failing.code === "tecINSUFFICIENT_FUNDS",
      `cover minimum enforced: withdraw below minimum rejected (${failing.code})`,
    );
    if (failing.hash) record("LoanBrokerCoverWithdraw (rejected)", failing.hash);
    // Cover unchanged by the rejected attempt.
    broker = await readLedgerEntry(client, brokerId);
    assert(BigInt(broker.CoverAvailable) === coverAvail, "cover unchanged after rejection");

    // ---- Positive control: smaller withdraw keeps cover >= minimum ----
    const okAmount = (slack / 2n).toString();
    const okWithdraw = await submitAndWait(
      client,
      {
        TransactionType: "LoanBrokerCoverWithdraw",
        Account: brokerOwner.address,
        LoanBrokerID: brokerId,
        Amount: okAmount,
      },
      brokerOwner,
    );
    record("LoanBrokerCoverWithdraw (ok)", okWithdraw.hash);
    broker = await readLedgerEntry(client, brokerId);
    const coverAfter = BigInt(broker.CoverAvailable);
    console.log(`  ok CoverWithdraw(${okAmount}) -> CoverAvailable=${coverAfter}`);
    assert(coverAfter === coverAvail - BigInt(okAmount), "cover reduced by the ok withdraw");
    assert(coverAfter >= requiredMin, "cover stays >= minimum after the ok withdraw");

    console.log(
      `\nFirst-loss cover proven: ${dropsToXrp(requiredMin.toString())} XRP minimum ` +
        `(${coverRateMinimum / 1000}% of ${dropsToXrp(debtTotal.toString())} XRP debt) enforced on withdraw.`,
    );
    console.log("\nExplorer links:\n" + links.join("\n"));
    console.log("\nPhase 1.2 complete: cover-minimum guardrail enforced; positive control passed.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ phase: "1.2", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
