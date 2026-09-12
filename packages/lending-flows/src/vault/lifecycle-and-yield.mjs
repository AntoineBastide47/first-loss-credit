// Vault Lifecycle and Yield
//
// Create an open-ended Single Asset Vault (XRP), deposit lender capital, generate
// REAL yield with one minimal loan cycle, then withdraw above par. Prove share
// value rises and that yield is derived, not stored.
//
// Independence: this flow builds its own owner/lender/borrower, vault, broker, and
// loan via the shared lib. It imports no other flow and reads no flow's state.
//
// Run:  node src/vault/lifecycle-and-yield.mjs

import {
  connect,
  fundAccounts,
  submitAndWait,
  roundUpToAssetUnit,
  readVault,
  readLedgerEntry,
  logFriction,
  dropsToXrp,
} from "../lib/index.mjs";
import {
  assert,
  makeRecorder,
  shareBalance,
  createVault,
  vaultDeposit,
  createBroker,
  depositCover,
  originateLoan,
} from "../lib/lending.mjs";

// Drops by which `account`'s XRP balance decreased in this tx (before - after).
function balanceDecrease(meta, account) {
  for (const n of meta.AffectedNodes || []) {
    const m = n.ModifiedNode;
    if (m?.LedgerEntryType === "AccountRoot" && m.FinalFields?.Account === account) {
      const before = BigInt(m.PreviousFields?.Balance ?? m.FinalFields.Balance);
      return (before - BigInt(m.FinalFields.Balance)).toString();
    }
  }
  return "0";
}

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // Preconditions: owner (vault + broker), lender, borrower.
    const [owner, lender, borrower] = await fundAccounts(client, 3);
    console.log(`owner=${owner.address}\nlender=${lender.address}\nborrower=${borrower.address}`);

    // Step 1: vault (owner).
    const { hash: vaultHash, vaultId, shareMptId } = await createVault(client, owner);
    record("VaultCreate", vaultHash);
    console.log(`  VaultID=${vaultId}\n  ShareMPTID=${shareMptId}`);

    // Step 2: deposit (lender).
    const depositDrops = "40000000"; // 40 XRP
    record("VaultDeposit", (await vaultDeposit(client, lender, vaultId, depositDrops)).hash);
    let vault = await readVault(client, vaultId);
    const sharesAfterDeposit = await shareBalance(client, lender.address, shareMptId);
    console.log(`  AssetsTotal=${vault.AssetsTotal} AssetsAvailable=${vault.AssetsAvailable}` +
      ` lenderShares=${sharesAfterDeposit} outstanding=${vault.shares.OutstandingAmount}`);
    assert(vault.AssetsTotal === depositDrops, "AssetsTotal == deposit");
    assert(vault.AssetsAvailable === depositDrops, "AssetsAvailable == deposit");
    assert(sharesAfterDeposit === depositDrops, "initial shares == deposit (Scale 0)");

    // Step 3: build yield with one minimal loan cycle.
    const { hash: brokerHash, brokerId } = await createBroker(client, owner, vaultId);
    record("LoanBrokerSet", brokerHash);
    record("LoanBrokerCoverDeposit", (await depositCover(client, owner, brokerId, "10000000")).hash);

    const { hash: loanHash, loanId } = await originateLoan(client, {
      borrower, owner, brokerId, principal: "20000000", // 20 XRP
    });
    record("LoanSet", loanHash);

    vault = await readVault(client, vaultId);
    console.log(`  after origination: AssetsTotal=${vault.AssetsTotal} AssetsAvailable=${vault.AssetsAvailable}`);
    assert(vault.AssetsAvailable === "20000000", "AssetsAvailable dropped by drawn principal (40 -> 20 XRP)");
    // Cash basis (LendingProtocolV1_1): interest is recognized on payment, so
    // AssetsTotal is unchanged at origination.
    assert(vault.AssetsTotal === depositDrops, "cash basis: AssetsTotal unchanged at origination");

    // Final payment (PaymentRemaining == 1: plain payment, no tfLoanFullPayment).
    const loan = await readLedgerEntry(client, loanId);
    const pay = await submitAndWait(client, {
      TransactionType: "LoanPay", Account: borrower.address, LoanID: loanId,
      Amount: roundUpToAssetUnit(loan.PeriodicPayment),
    }, borrower);
    record("LoanPay", pay.hash);
    vault = await readVault(client, vaultId);
    console.log(`  after repayment: AssetsTotal=${vault.AssetsTotal} AssetsAvailable=${vault.AssetsAvailable}`);
    assert(BigInt(vault.AssetsTotal) > BigInt(depositDrops),
      `yield realized: AssetsTotal ${vault.AssetsTotal} > deposit ${depositDrops}`);
    assert(vault.AssetsAvailable === vault.AssetsTotal, "all assets liquid again after repayment");

    // Step 4: redeem ALL shares (share MPT amount) to receive their full value.
    const shares = await shareBalance(client, lender.address, shareMptId);
    const withdraw = await submitAndWait(client, {
      TransactionType: "VaultWithdraw", Account: lender.address, VaultID: vaultId,
      Amount: { mpt_issuance_id: shareMptId, value: shares },
    }, lender);
    record("VaultWithdraw", withdraw.hash);

    // Gross payout = vault pseudo-account outflow (the lender's own delta nets its tx fee).
    const payoutDrops = balanceDecrease(withdraw.meta, vault.Account);
    console.log(`  redeemed shares=${shares} vault payout=${payoutDrops} drops (deposit was ${depositDrops})`);
    assert(BigInt(payoutDrops) > BigInt(depositDrops),
      `withdraw pays MORE than deposit (${payoutDrops} > ${depositDrops})`);

    console.log(`\nLender gain on redemption: ${dropsToXrp((BigInt(payoutDrops) - BigInt(depositDrops)).toString())} XRP` +
      ` (real loan interest, derived from share price, not a stored field)`);
    printLinks();
    console.log("\nComplete: share value rose from real loan interest.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ flow: "vault/lifecycle-and-yield", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
