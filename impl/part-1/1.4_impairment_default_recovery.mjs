// Phase 1.4 — Impairment, Default, and Recovery
//
// Drive a loan through impairment and default and prove first-loss recovery: cover
// is liquidated to the vault and the residual becomes a realized vault loss. Also
// prove the timing guards: impair before overdue and default before the grace
// window both return tecTOO_SOON.
//
// Independence: builds its own funded vault, broker with cover, borrower, and one
// short-interval loan, then lets it go overdue.
//
// Run:  node part-1/1.4_impairment_default_recovery.mjs   (waits ~2-3 min for windows)

import { VaultWithdrawalPolicy, LoanManageFlags } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  signLoanSetCounterparty,
  waitUntilAfter,
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
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  assert ok: ${msg}`);
}
const lm = (owner, loanId, flag) => ({
  TransactionType: "LoanManage", Account: owner.address, LoanID: loanId, Flags: flag,
});

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);

  try {
    const [owner, lender, borrower] = await fundAccounts(client, 3);
    console.log(`owner=${owner.address}\nlender=${lender.address}\nborrower=${borrower.address}`);

    // Funded vault (owner) + lender deposit.
    const vc = await submitAndWait(client, {
      TransactionType: "VaultCreate", Account: owner.address, Asset: XRP,
      WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
    }, owner);
    record("VaultCreate", vc.hash);
    const vaultId = created(vc.meta, "Vault");
    record("VaultDeposit", (await submitAndWait(client, {
      TransactionType: "VaultDeposit", Account: lender.address, VaultID: vaultId, Amount: "100000000",
    }, lender)).hash); // 100 XRP

    // Broker: low CoverRateMinimum so origination passes with modest cover; full
    // liquidation rate. Cover (10 XRP) is smaller than the loan so a residual loss remains.
    const coverRateMinimum = 10000; // 10%
    const coverRateLiquidation = 100000; // 100%
    const bs = await submitAndWait(client, {
      TransactionType: "LoanBrokerSet", Account: owner.address, VaultID: vaultId,
      ManagementFeeRate: 0, DebtMaximum: "1000000000",
      CoverRateMinimum: coverRateMinimum, CoverRateLiquidation: coverRateLiquidation,
    }, owner);
    record("LoanBrokerSet", bs.hash);
    const brokerId = created(bs.meta, "LoanBroker");
    record("LoanBrokerCoverDeposit", (await submitAndWait(client, {
      TransactionType: "LoanBrokerCoverDeposit", Account: owner.address, LoanBrokerID: brokerId, Amount: "10000000",
    }, owner)).hash); // 10 XRP cover

    // One loan, shortest windows (PaymentInterval >= 60, GracePeriod >= 60 and <= interval).
    const loanSetTx = await client.autofill({
      TransactionType: "LoanSet", Account: borrower.address, Counterparty: owner.address,
      LoanBrokerID: brokerId, PrincipalRequested: "40000000", // 40 XRP
      InterestRate: 100000, PaymentInterval: 60, PaymentTotal: 1, GracePeriod: 60,
    });
    const loanRes = await client.submitAndWait(
      signLoanSetCounterparty(borrower.sign(loanSetTx).tx_blob, owner).tx_blob,
    );
    assert(loanRes.result.meta?.TransactionResult === "tesSUCCESS", "LoanSet tesSUCCESS");
    record("LoanSet", loanRes.result.hash);
    const loanId = created(loanRes.result.meta, "Loan");
    let loan = await readLedgerEntry(client, loanId);
    const dueDate = loan.NextPaymentDueDate;
    const graceEnd = dueDate + loan.GracePeriod;
    console.log(`  LoanID=${loanId} NextPaymentDueDate=${dueDate} graceEnd=${graceEnd}` +
      ` TotalValueOutstanding=${loan.TotalValueOutstanding}`);

    // ---- Negative control 1: impair before overdue -> tecTOO_SOON ----
    const earlyImpair = await submitExpectingFailure(client, lm(owner, loanId, LoanManageFlags.tfLoanImpair), owner);
    console.log(`  impair before overdue -> ${earlyImpair.code}`);
    assert(earlyImpair.code === "tecTOO_SOON", `impair before overdue -> tecTOO_SOON (${earlyImpair.code})`);

    // ---- Step 2: wait until overdue, then impair ----
    console.log(`  waiting until ledger time > NextPaymentDueDate (${dueDate}) ...`);
    await waitUntilAfter(client, dueDate);
    const vaultBeforeImpair = await readVault(client, vaultId);
    const impair = await submitAndWait(client, lm(owner, loanId, LoanManageFlags.tfLoanImpair), owner);
    record("LoanManage impair", impair.hash);
    loan = await readLedgerEntry(client, loanId);
    const vaultAfterImpair = await readVault(client, vaultId);
    const lossUnrealized = BigInt(vaultAfterImpair.LossUnrealized ?? "0");
    console.log(`  loan.Flags=${loan.Flags} LossUnrealized ${vaultBeforeImpair.LossUnrealized ?? "0"} -> ${vaultAfterImpair.LossUnrealized ?? "0"}`);
    assert((loan.Flags & 0x00020000) !== 0, "lsfLoanImpaired set after impair");
    assert(lossUnrealized > 0n, "Vault.LossUnrealized increased on impair (share value drops)");

    // ---- Negative control 2: default before the grace window -> tecTOO_SOON ----
    const earlyDefault = await submitExpectingFailure(client, lm(owner, loanId, LoanManageFlags.tfLoanDefault), owner);
    console.log(`  default before grace end -> ${earlyDefault.code}`);
    assert(earlyDefault.code === "tecTOO_SOON", `default before grace -> tecTOO_SOON (${earlyDefault.code})`);

    // ---- Step 3+4: wait strictly beyond grace, then default ----
    console.log(`  waiting until ledger time > graceEnd (${graceEnd}) ...`);
    await waitUntilAfter(client, graceEnd);
    const vaultBeforeDefault = await readVault(client, vaultId);
    const brokerBeforeDefault = await readLedgerEntry(client, brokerId);
    const dflt = await submitAndWait(client, lm(owner, loanId, LoanManageFlags.tfLoanDefault), owner);
    record("LoanManage default", dflt.hash);
    loan = await readLedgerEntry(client, loanId).catch(() => null); // may be deleted
    const vaultAfterDefault = await readVault(client, vaultId);
    const brokerAfterDefault = await readLedgerEntry(client, brokerId);

    // XRPL omits zero-valued fields, so CoverAvailable / DebtTotal can be absent after default.
    const big = (v) => BigInt(v ?? "0");
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

    // First-loss recovery invariants (directional; high-precision so no exact arithmetic).
    assert(defaultCovered > 0n, "cover liquidated to the vault on default (DefaultCovered > 0)");
    assert(availAfter - availBefore === defaultCovered, "AssetsAvailable += DefaultCovered (cover cash arrives)");
    assert(debtAfter < debtBefore, "DebtTotal reduced by the defaulted amount");
    assert(realizedLoss > 0n, "AssetsTotal dropped: residual is a realized vault loss");
    assert(BigInt(vaultAfterDefault.LossUnrealized ?? "0") === 0n, "unrealized loss reversed (moved to realized)");
    // Conservation: defaulted debt = cover recovered + realized loss (within 1 base unit).
    const defaultAmount = debtBefore - debtAfter;
    const recoveredPlusLoss = defaultCovered + realizedLoss;
    const diff = defaultAmount > recoveredPlusLoss ? defaultAmount - recoveredPlusLoss : recoveredPlusLoss - defaultAmount;
    console.log(`  DefaultAmount=${defaultAmount} covered+loss=${recoveredPlusLoss} diff=${diff}`);
    assert(diff <= 1n, "conservation: DefaultAmount == DefaultCovered + realized loss (±1 drop)");

    console.log(`\nFirst-loss recovery proven: ${dropsToXrp(defaultCovered.toString())} XRP cover absorbed the` +
      ` first loss; ${dropsToXrp(realizedLoss.toString())} XRP residual hit senior lenders.`);
    console.log("\nExplorer links:\n" + links.join("\n"));
    console.log("\nPhase 1.4 complete: impair, default, first-loss recovery, and timing guards verified.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ phase: "1.4", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
