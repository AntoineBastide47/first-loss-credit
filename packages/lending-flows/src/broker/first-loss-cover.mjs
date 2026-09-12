// Loan Broker and First-Loss Cover
//
// Create a loan broker on a funded vault, deposit first-loss cover, read the cover
// parameters, then prove the cover-minimum guardrail: a CoverWithdraw that would
// drop cover below DebtTotal * CoverRateMinimum while debt is outstanding is
// rejected (tecINSUFFICIENT_FUNDS). A smaller withdraw that keeps cover >= minimum
// succeeds.
//
// Independence: builds its own vault, broker, and one outstanding loan via the
// shared lib. It imports no other flow and reads no flow's state.
//
// Run:  node src/broker/first-loss-cover.mjs

import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  readLedgerEntry,
  logFriction,
  dropsToXrp,
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

const COVER_RATE_DENOM = 100000n; // cover rates are 1/10 bps: 100% = 100000

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // brokerOwner must own the vault (LoanBrokerSet requires Account == Vault.Owner).
    const [brokerOwner, lender, borrower] = await fundAccounts(client, 3);
    console.log(`brokerOwner=${brokerOwner.address}\nlender=${lender.address}\nborrower=${borrower.address}`);

    const { hash: vaultHash, vaultId } = await createVault(client, brokerOwner);
    record("VaultCreate", vaultHash);
    record("VaultDeposit", (await vaultDeposit(client, lender, vaultId, "100000000")).hash); // 100 XRP

    // Step 1: broker with cover parameters.
    const coverRateMinimum = 50000; // 50% of DebtTotal must be covered
    const coverRateLiquidation = 20000; // 20% of the minimum liquidated per default
    const { hash: brokerHash, brokerId } = await createBroker(client, brokerOwner, vaultId, {
      managementFeeRate: 500, coverRateMinimum, coverRateLiquidation,
    });
    record("LoanBrokerSet", brokerHash);
    let broker = await readLedgerEntry(client, brokerId);
    console.log(`  LoanBrokerID=${brokerId}`);
    console.log(`  broker: ManagementFeeRate=${broker.ManagementFeeRate}` +
      ` CoverRateMinimum=${broker.CoverRateMinimum} CoverRateLiquidation=${broker.CoverRateLiquidation}`);
    assert(broker.CoverRateMinimum === coverRateMinimum, "CoverRateMinimum stored as set");
    assert(broker.CoverRateLiquidation === coverRateLiquidation, "CoverRateLiquidation stored as set");
    assert(broker.ManagementFeeRate === 500, "ManagementFeeRate stored as set");

    // Step 2: cover deposit.
    const coverAmount = "30000000"; // 30 XRP first-loss cover
    record("LoanBrokerCoverDeposit", (await depositCover(client, brokerOwner, brokerId, coverAmount)).hash);
    broker = await readLedgerEntry(client, brokerId);
    console.log(`  CoverAvailable=${broker.CoverAvailable} (deposited ${coverAmount})`);
    assert(broker.CoverAvailable === coverAmount, "CoverAvailable == deposit");

    // Step 3: one loan so DebtTotal > 0.
    const { hash: loanHash } = await originateLoan(client, {
      borrower, owner: brokerOwner, brokerId, principal: "40000000", // 40 XRP
      terms: { PaymentInterval: 3600, PaymentTotal: 4, GracePeriod: 300 },
    });
    record("LoanSet", loanHash);

    broker = await readLedgerEntry(client, brokerId);
    const debtTotal = BigInt(broker.DebtTotal);
    const coverAvail = BigInt(broker.CoverAvailable);
    const requiredMin = (debtTotal * BigInt(coverRateMinimum)) / COVER_RATE_DENOM;
    const slack = coverAvail - requiredMin;
    console.log(`  DebtTotal=${debtTotal} CoverAvailable=${coverAvail}` +
      ` requiredMin=DebtTotal*${coverRateMinimum}/100000=${requiredMin} slack=${slack}`);
    assert(debtTotal > 0n, "DebtTotal > 0 after origination");
    assert(slack > 2n, "cover slack exists for a meaningful test");

    // Step 4: failing CoverWithdraw (drops cover below the minimum).
    const failingAmount = (slack + 1000000n).toString(); // 1 XRP past the edge
    const failing = await submitExpectingFailure(client, {
      TransactionType: "LoanBrokerCoverWithdraw", Account: brokerOwner.address,
      LoanBrokerID: brokerId, Amount: failingAmount,
    }, brokerOwner);
    console.log(`  failing CoverWithdraw(${failingAmount}) -> ${failing.code}`);
    assert(failing.code === "tecINSUFFICIENT_FUNDS",
      `cover minimum enforced: withdraw below minimum rejected (${failing.code})`);
    if (failing.hash) record("LoanBrokerCoverWithdraw (rejected)", failing.hash);
    broker = await readLedgerEntry(client, brokerId);
    assert(BigInt(broker.CoverAvailable) === coverAvail, "cover unchanged after rejection");

    // Positive control: smaller withdraw keeps cover >= minimum.
    const okAmount = (slack / 2n).toString();
    const okWithdraw = await submitAndWait(client, {
      TransactionType: "LoanBrokerCoverWithdraw", Account: brokerOwner.address,
      LoanBrokerID: brokerId, Amount: okAmount,
    }, brokerOwner);
    record("LoanBrokerCoverWithdraw (ok)", okWithdraw.hash);
    broker = await readLedgerEntry(client, brokerId);
    const coverAfter = BigInt(broker.CoverAvailable);
    console.log(`  ok CoverWithdraw(${okAmount}) -> CoverAvailable=${coverAfter}`);
    assert(coverAfter === coverAvail - BigInt(okAmount), "cover reduced by the ok withdraw");
    assert(coverAfter >= requiredMin, "cover stays >= minimum after the ok withdraw");

    console.log(`\nFirst-loss cover proven: ${dropsToXrp(requiredMin.toString())} XRP minimum ` +
      `(${coverRateMinimum / 1000}% of ${dropsToXrp(debtTotal.toString())} XRP debt) enforced on withdraw.`);
    printLinks();
    console.log("\nComplete: cover-minimum guardrail enforced; positive control passed.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ flow: "broker/first-loss-cover", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
