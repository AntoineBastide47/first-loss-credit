// Impairment, Default, and Recovery
//
// Drive a loan through impairment and default and prove first-loss recovery: cover
// is liquidated to the vault and the residual becomes a realized vault loss. Also
// prove the timing guards: impair before overdue and default before the grace
// window both return tecTOO_SOON.
//
// Independence: builds its own funded vault, broker with cover, borrower, and one
// short-interval loan via the shared lib, then lets it go overdue. It imports no
// other flow and reads no flow's state.
//
// Run:  node src/loan/impairment-default-recovery.mjs   (waits ~2-3 min for windows)

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
  dropsToXrp,
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

const lm = (owner, loanId, flag) => ({
  TransactionType: "LoanManage", Account: owner.address, LoanID: loanId, Flags: flag,
});

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    const [owner, lender, borrower] = await fundAccounts(client, 3);
    console.log(`owner=${owner.address}\nlender=${lender.address}\nborrower=${borrower.address}`);

    const { hash: vaultHash, vaultId } = await createVault(client, owner);
    record("VaultCreate", vaultHash);
    record("VaultDeposit", (await vaultDeposit(client, lender, vaultId, "100000000")).hash); // 100 XRP

    // Low CoverRateMinimum so origination passes; full liquidation rate. Cover (10 XRP)
    // is smaller than the loan so a residual loss remains.
    const { hash: brokerHash, brokerId } = await createBroker(client, owner, vaultId, {
      coverRateMinimum: 10000, coverRateLiquidation: 100000, // 10% / 100%
    });
    record("LoanBrokerSet", brokerHash);
    record("LoanBrokerCoverDeposit", (await depositCover(client, owner, brokerId, "10000000")).hash); // 10 XRP

    // One loan, shortest windows (PaymentInterval >= 60, GracePeriod >= 60 and <= interval).
    const loan0 = await originateLoan(client, {
      borrower, owner, brokerId, principal: "40000000", // 40 XRP
      terms: { PaymentInterval: 60, PaymentTotal: 1, GracePeriod: 60 },
    });
    record("LoanSet", loan0.hash);
    const loanId = loan0.loanId;
    let loan = await readLedgerEntry(client, loanId);
    const dueDate = loan.NextPaymentDueDate;
    const graceEnd = dueDate + loan.GracePeriod;
    console.log(`  LoanID=${loanId} NextPaymentDueDate=${dueDate} graceEnd=${graceEnd}` +
      ` TotalValueOutstanding=${loan.TotalValueOutstanding}`);

    // Negative control 1: impair before overdue -> tecTOO_SOON.
    const earlyImpair = await submitExpectingFailure(client, lm(owner, loanId, LoanManageFlags.tfLoanImpair), owner);
    console.log(`  impair before overdue -> ${earlyImpair.code}`);
    assert(earlyImpair.code === "tecTOO_SOON", `impair before overdue -> tecTOO_SOON (${earlyImpair.code})`);

    // Step 2: wait until overdue, then impair.
    console.log(`  waiting until ledger time > NextPaymentDueDate (${dueDate}) ...`);
    await waitUntilAfter(client, dueDate);
    const vaultBeforeImpair = await readVault(client, vaultId);
    const impair = await submitAndWait(client, lm(owner, loanId, LoanManageFlags.tfLoanImpair), owner);
    record("LoanManage impair", impair.hash);
    loan = await readLedgerEntry(client, loanId);
    const vaultAfterImpair = await readVault(client, vaultId);
    console.log(`  loan.Flags=${loan.Flags} LossUnrealized ${vaultBeforeImpair.LossUnrealized ?? "0"} -> ${vaultAfterImpair.LossUnrealized ?? "0"}`);
    assert((loan.Flags & 0x00020000) !== 0, "lsfLoanImpaired set after impair");
    assert(big(vaultAfterImpair.LossUnrealized) > 0n, "Vault.LossUnrealized increased on impair (share value drops)");

    // Negative control 2: default before the grace window -> tecTOO_SOON.
    const earlyDefault = await submitExpectingFailure(client, lm(owner, loanId, LoanManageFlags.tfLoanDefault), owner);
    console.log(`  default before grace end -> ${earlyDefault.code}`);
    assert(earlyDefault.code === "tecTOO_SOON", `default before grace -> tecTOO_SOON (${earlyDefault.code})`);

    // Step 3+4: wait strictly beyond grace, then default.
    console.log(`  waiting until ledger time > graceEnd (${graceEnd}) ...`);
    await waitUntilAfter(client, graceEnd);
    const vaultBeforeDefault = await readVault(client, vaultId);
    const brokerBeforeDefault = await readLedgerEntry(client, brokerId);
    const dflt = await submitAndWait(client, lm(owner, loanId, LoanManageFlags.tfLoanDefault), owner);
    record("LoanManage default", dflt.hash);
    const vaultAfterDefault = await readVault(client, vaultId);
    const brokerAfterDefault = await readLedgerEntry(client, brokerId);

    // XRPL omits zero-valued fields, so CoverAvailable / DebtTotal can be absent after default.
    const coverBefore = big(brokerBeforeDefault.CoverAvailable);
    const coverAfter = big(brokerAfterDefault.CoverAvailable);
    const defaultCovered = coverBefore - coverAfter;
    const availBefore = big(vaultBeforeDefault.AssetsAvailable);
    const availAfter = big(vaultAfterDefault.AssetsAvailable);
    const totalBefore = big(vaultBeforeDefault.AssetsTotal);
    const totalAfter = big(vaultAfterDefault.AssetsTotal);
    const debtBefore = big(brokerBeforeDefault.DebtTotal);
    const debtAfter = big(brokerAfterDefault.DebtTotal);
    const realizedLoss = totalBefore - totalAfter;

    console.log(`  CoverAvailable ${coverBefore} -> ${coverAfter}  (DefaultCovered=${defaultCovered})`);
    console.log(`  AssetsAvailable ${availBefore} -> ${availAfter}  (Δ=${availAfter - availBefore})`);
    console.log(`  AssetsTotal ${totalBefore} -> ${totalAfter}  (realized loss=${realizedLoss})`);
    console.log(`  DebtTotal ${debtBefore} -> ${debtAfter}`);
    console.log(`  LossUnrealized ${vaultBeforeDefault.LossUnrealized ?? "0"} -> ${vaultAfterDefault.LossUnrealized ?? "0"}`);

    // First-loss recovery invariants (directional; high-precision, so no exact arithmetic).
    assert(defaultCovered > 0n, "cover liquidated to the vault on default (DefaultCovered > 0)");
    assert(availAfter - availBefore === defaultCovered, "AssetsAvailable += DefaultCovered (cover cash arrives)");
    assert(debtAfter < debtBefore, "DebtTotal reduced by the defaulted amount");
    assert(realizedLoss > 0n, "AssetsTotal dropped: residual is a realized vault loss");
    assert(big(vaultAfterDefault.LossUnrealized) === 0n, "unrealized loss reversed (moved to realized)");
    // Conservation: defaulted debt = cover recovered + realized loss (within 1 base unit).
    const defaultAmount = debtBefore - debtAfter;
    const recoveredPlusLoss = defaultCovered + realizedLoss;
    const diff = defaultAmount > recoveredPlusLoss ? defaultAmount - recoveredPlusLoss : recoveredPlusLoss - defaultAmount;
    console.log(`  DefaultAmount=${defaultAmount} covered+loss=${recoveredPlusLoss} diff=${diff}`);
    assert(diff <= 1n, "conservation: DefaultAmount == DefaultCovered + realized loss (±1 drop)");

    console.log(`\nFirst-loss recovery proven: ${dropsToXrp(defaultCovered.toString())} XRP cover absorbed the` +
      ` first loss; ${dropsToXrp(realizedLoss.toString())} XRP residual hit senior lenders.`);
    printLinks();
    console.log("\nComplete: impair, default, first-loss recovery, and timing guards verified.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ flow: "loan/impairment-default-recovery", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
