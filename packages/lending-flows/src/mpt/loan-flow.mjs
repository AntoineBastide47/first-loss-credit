// MPT Loan Flow
//
// Run a full loan (originate + repay) in an MPT-denominated vault and prove the
// payment rounding rule: the high-precision periodic payment must be paid as a whole
// MPT base unit, rounded UP.
//
// Two representations coexist: loan accounting fields (PeriodicPayment,
// TotalValueOutstanding) stay high-precision decimals, while MPT balances and the
// paid Amount are integer base units. PrincipalRequested is a plain XRPLNumber string;
// only LoanPay.Amount is the MPT object { mpt_issuance_id, value }.
//
// Independence: this flow issues its own MPT, builds an MPT vault, a broker with MPT
// cover, and one loan via the shared lib. It imports no other flow.
//
// Run:  node src/mpt/loan-flow.mjs

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
  createVault,
  vaultDeposit,
  createBroker,
  depositCover,
  originateLoan,
} from "../lib/lending.mjs";
import { MPTokenIssuanceCreateFlags as F, createMptIssuance, authorizeMpt, mptBalance } from "../lib/mpt.mjs";

const MPT_ASSET_SCALE = 2; // token precision, distinct from the loan's internal LoanScale
const truncate = (v) => String(v).split(".")[0]; // floor of a decimal string

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // Preconditions: issuer, lender, owner (vault + broker), borrower.
    const [issuer, lender, owner, borrower] = await fundAccounts(client, 4);
    console.log(`issuer=${issuer.address}\nlender=${lender.address}\nowner=${owner.address}\nborrower=${borrower.address}`);

    // Transferable MPT; opt in lender, owner, borrower; mint to each who needs it.
    const { hash: mptHash, issuanceId } = await createMptIssuance(client, issuer, {
      flags: F.tfMPTCanTransfer, assetScale: MPT_ASSET_SCALE, maximumAmount: "1000000000000",
    });
    record("MPTokenIssuanceCreate", mptHash);
    console.log(`  MPTokenIssuanceID=${issuanceId}`);

    for (const acct of [lender, owner, borrower]) await authorizeMpt(client, acct, issuanceId);
    const mint = async (to, value) => submitAndWait(client, {
      TransactionType: "Payment", Account: issuer.address, Destination: to.address,
      Amount: { mpt_issuance_id: issuanceId, value },
    }, issuer);
    await mint(lender, "10000000");
    await mint(owner, "5000000");
    await mint(borrower, "2000000"); // buffer to cover interest + fees beyond received principal

    // MPT vault funded by the lender; broker on it with MPT cover.
    const { hash: vaultHash, vaultId } = await createVault(client, owner, { asset: { mpt_issuance_id: issuanceId } });
    record("VaultCreate", vaultHash);
    record("VaultDeposit", (await vaultDeposit(client, lender, vaultId, { mpt_issuance_id: issuanceId, value: "5000000" })).hash);
    const { hash: brokerHash, brokerId } = await createBroker(client, owner, vaultId);
    record("LoanBrokerSet", brokerHash);
    record("LoanBrokerCoverDeposit",
      (await depositCover(client, owner, brokerId, { mpt_issuance_id: issuanceId, value: "2000000" })).hash);

    // Step 1: LoanSet (dual-signed). PrincipalRequested is a STRING, not an MPT object.
    const principal = "1000000"; // MPT base units
    const vaultBefore = await readVault(client, vaultId);
    const brokerBefore = await readLedgerEntry(client, brokerId);
    const borrowerMptBefore = await mptBalance(client, borrower, issuanceId);
    const loan0 = await originateLoan(client, {
      borrower, owner, brokerId, principal,
      terms: { PaymentInterval: 3600, PaymentTotal: 1, GracePeriod: 300, InterestRate: 100000, LoanOriginationFee: "10000" },
    });
    record("LoanSet", loan0.hash);
    const loan = await readLedgerEntry(client, loan0.loanId);
    const brokerAfter = await readLedgerEntry(client, brokerId);
    const borrowerMptAfterOrig = await mptBalance(client, borrower, issuanceId);
    console.log(`  loan: PrincipalOutstanding=${loan.PrincipalOutstanding} PeriodicPayment=${loan.PeriodicPayment}` +
      ` TotalValueOutstanding=${loan.TotalValueOutstanding} PaymentRemaining=${loan.PaymentRemaining}`);
    console.log(`  DebtTotal ${brokerBefore.DebtTotal ?? "0"} -> ${brokerAfter.DebtTotal}`);
    console.log(`  borrower MPT ${borrowerMptBefore} -> ${borrowerMptAfterOrig} (received principal minus origination fee)`);

    // Origination moved MPT principal (minus origination fee) to the borrower.
    const received = BigInt(borrowerMptAfterOrig) - BigInt(borrowerMptBefore);
    assert(received === BigInt(principal) - 10000n, "borrower received principal minus origination fee in MPT");
    assert(BigInt(brokerAfter.DebtTotal) >= BigInt(principal), "DebtTotal rose by at least principal");
    // Loan accounting stays high-precision even though MPT balances are integers.
    assert(loan.PeriodicPayment.includes(".") || loan.TotalValueOutstanding.includes("."),
      "loan fields keep decimal precision while MPT balances are integer base units");

    // Step 2: the rounding lesson.
    const periodic = loan.PeriodicPayment;
    const floorAmt = truncate(periodic); // truncated DOWN to a whole base unit
    const ceilAmt = roundUpToAssetUnit(periodic); // rounded UP to a whole base unit
    console.log(`  PeriodicPayment=${periodic} -> floor=${floorAmt} ceil=${ceilAmt}`);

    // Truncated-down payment falls short. For an MPT vault the sub-unit shortfall is
    // NOT tolerated (unlike the XRP drops case), so floor -> tecINSUFFICIENT_PAYMENT.
    const floorTry = await submitExpectingFailure(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: loan0.loanId,
      Amount: { mpt_issuance_id: issuanceId, value: floorAmt },
    }, borrower);
    console.log(`  LoanPay floor(${floorAmt}) -> ${floorTry.code}`);
    assert(floorTry.code === "tecINSUFFICIENT_PAYMENT",
      "truncated-down MPT payment falls short -> tecINSUFFICIENT_PAYMENT");

    // Rounded-up payment settles the loan.
    const payResult = await submitAndWait(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: loan0.loanId,
      Amount: { mpt_issuance_id: issuanceId, value: ceilAmt },
    }, borrower);
    record("LoanPay (rounded up)", payResult.hash);
    const vaultAfter = await readVault(client, vaultId);
    console.log(`  after rounded-up LoanPay: vault AssetsTotal ${vaultBefore.AssetsTotal} -> ${vaultAfter.AssetsTotal}`);
    assert(BigInt(vaultAfter.AssetsTotal) > BigInt(vaultBefore.AssetsTotal),
      "interest booked to AssetsTotal in MPT units after payment (cash basis)");

    printLinks();

    // Friction to capture.
    logFriction({
      flow: "mpt/loan-flow", surface: "protocol", feature: "xls-66", tx_type: "LoanPay",
      note: `MPT integer base units collide with the loan's decimal PeriodicPayment (${periodic}). The paid MPT amount must be a whole base unit rounded UP; there is no SDK helper, so rounding is manual (roundUpToAssetUnit). Verified contrast: truncating the fraction down fails tecINSUFFICIENT_PAYMENT for an MPT vault, while the XRP drops case tolerates the same sub-unit truncation.`,
    });
    logFriction({
      flow: "mpt/loan-flow", surface: "sdk", feature: "xls-33", tx_type: "LoanSet",
      note: "PrincipalRequested is a plain XRPLNumber string; only LoanPay.Amount is the MPT object { mpt_issuance_id, value }. The string-vs-object split is easy to mix up.",
    });

    console.log(`\nComplete: MPT loan originated and repaid; pay amount must round UP to a whole base unit.`);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ flow: "mpt/loan-flow", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
