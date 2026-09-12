// Phase 1.1 — Vault Lifecycle and Yield
//
// Create an open-ended Single Asset Vault (XRP), deposit lender capital, generate
// REAL yield with one minimal loan cycle, then withdraw above par. Prove share
// value rises and that yield is derived, not stored.
//
// Independence: this phase builds its own owner/lender/borrower, vault, broker, and
// loan. It reads no other phase's runtime state.
//
// Run:  node part-1/1.1_vault_lifecycle_and_yield.mjs
// Net:  XRPL_WSS overrides the endpoint (default public Devnet).

import { VaultWithdrawalPolicy } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
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

// Find a created ledger object of a given type in tx metadata.
function createdIndex(meta, entryType) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === entryType) return c.LedgerIndex;
  }
  throw new Error(`no created ${entryType} in metadata`);
}
function createdFields(meta, entryType) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === entryType) return c.NewFields;
  }
  throw new Error(`no created ${entryType} in metadata`);
}

// Lender's share balance (MPToken for the vault share issuance).
async function shareBalance(client, holder, shareMptId) {
  const { result } = await client.request({
    command: "account_objects",
    account: holder,
    type: "mptoken",
  });
  const tok = (result.account_objects || []).find(
    (o) => o.MPTokenIssuanceID === shareMptId,
  );
  return tok ? tok.MPTAmount ?? "0" : "0";
}

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);

  try {
    // ---- Preconditions: fund owner (vault+broker), lender, borrower ----
    const [owner, lender, borrower] = await fundAccounts(client, 3);
    console.log(`owner=${owner.address}\nlender=${lender.address}\nborrower=${borrower.address}`);

    // ---- Step 1: VaultCreate (owner) ----
    const vaultCreate = await submitAndWait(
      client,
      {
        TransactionType: "VaultCreate",
        Account: owner.address,
        Asset: XRP,
        WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
        // Omit Scale (forced 0 for XRP), DomainID, tfVaultPrivate (public vault).
      },
      owner,
    );
    record("VaultCreate", vaultCreate.hash);
    const vaultId = createdIndex(vaultCreate.meta, "Vault");
    let vault = await readVault(client, vaultId);
    const shareMptId = vault.ShareMPTID;
    console.log(`  VaultID=${vaultId}\n  ShareMPTID=${shareMptId}\n  Scale=${vault.Scale ?? 0}`);

    // ---- Step 2: VaultDeposit (lender) ----
    const depositDrops = "40000000"; // 40 XRP (faucet funds 100 XRP/account)
    const deposit = await submitAndWait(
      client,
      {
        TransactionType: "VaultDeposit",
        Account: lender.address,
        VaultID: vaultId,
        Amount: depositDrops,
      },
      lender,
    );
    record("VaultDeposit", deposit.hash);
    vault = await readVault(client, vaultId);
    const sharesAfterDeposit = await shareBalance(client, lender.address, shareMptId);
    console.log(
      `  AssetsTotal=${vault.AssetsTotal} AssetsAvailable=${vault.AssetsAvailable}` +
        ` lenderShares=${sharesAfterDeposit} outstanding=${vault.shares.OutstandingAmount}`,
    );
    assert(vault.AssetsTotal === depositDrops, "AssetsTotal == deposit");
    assert(vault.AssetsAvailable === depositDrops, "AssetsAvailable == deposit");
    assert(sharesAfterDeposit === depositDrops, "initial shares == deposit (Scale 0)");

    // ---- Step 3a: LoanBrokerSet (owner) ----
    const brokerSet = await submitAndWait(
      client,
      {
        TransactionType: "LoanBrokerSet",
        Account: owner.address,
        VaultID: vaultId,
        ManagementFeeRate: 0, // 0..10000
        DebtMaximum: "1000000000", // 1000 XRP cap
      },
      owner,
    );
    record("LoanBrokerSet", brokerSet.hash);
    const brokerId = createdIndex(brokerSet.meta, "LoanBroker");
    console.log(`  LoanBrokerID=${brokerId}`);

    // ---- Step 3b: LoanBrokerCoverDeposit (owner posts first-loss cover) ----
    const coverDeposit = await submitAndWait(
      client,
      {
        TransactionType: "LoanBrokerCoverDeposit",
        Account: owner.address,
        LoanBrokerID: brokerId,
        Amount: "10000000", // 10 XRP cover
      },
      owner,
    );
    record("LoanBrokerCoverDeposit", coverDeposit.hash);

    // ---- Step 3c: LoanSet (borrower initiates, owner co-signs) ----
    const principalDrops = "20000000"; // 20 XRP
    const loanSetTx = await client.autofill({
      TransactionType: "LoanSet",
      Account: borrower.address,
      Counterparty: owner.address, // broker owner is the counterparty
      LoanBrokerID: brokerId,
      PrincipalRequested: principalDrops,
      InterestRate: 100000, // 10% annualized, units 1/10 bps -> 100000 = 10%
      PaymentInterval: 60, // seconds
      PaymentTotal: 1,
      GracePeriod: 60,
    });
    const borrowerSigned = borrower.sign(loanSetTx);
    const cosigned = signLoanSetCounterparty(borrowerSigned.tx_blob, owner);
    const loanRes = await client.submitAndWait(cosigned.tx_blob);
    const loanCode = loanRes.result.meta?.TransactionResult;
    assert(loanCode === "tesSUCCESS", `LoanSet tesSUCCESS (got ${loanCode})`);
    record("LoanSet", loanRes.result.hash);
    const loanId = createdIndex(loanRes.result.meta, "Loan");
    const loanFields = createdFields(loanRes.result.meta, "Loan");
    console.log(`  LoanID=${loanId}`);
    console.log(`  loan fields: ${JSON.stringify(loanFields)}`);

    vault = await readVault(client, vaultId);
    const assetsTotalAfterOrigination = vault.AssetsTotal;
    console.log(
      `  after origination: AssetsTotal=${vault.AssetsTotal} AssetsAvailable=${vault.AssetsAvailable}`,
    );
    assert(
      vault.AssetsAvailable === "20000000",
      `AssetsAvailable dropped by drawn principal (40 -> 20 XRP)`,
    );
    // Observed on this build (LendingProtocolV1_1): interest is recognized on
    // payment (cash basis), so AssetsTotal is UNCHANGED at origination, not raised
    // by InterestDue. The plan's accrual-at-origination note is corrected to this.
    assert(
      assetsTotalAfterOrigination === depositDrops,
      `cash basis: AssetsTotal unchanged at origination (no accrual)`,
    );

    // ---- Step 3d: LoanPay final payment (borrower repays principal + interest) ----
    const loan = await readLedgerEntry(client, loanId);
    console.log(`  loan object: ${JSON.stringify(loan)}`);
    // PaymentRemaining == 1: this is the final payment. Do NOT set tfLoanFullPayment
    // (that flag is for early full repayment when PaymentRemaining > 1). Pay the
    // periodic amount rounded UP to a whole base unit (drops).
    const payAmount = roundUpToAssetUnit(loan.PeriodicPayment, XRP);
    const pay = await submitAndWait(
      client,
      {
        TransactionType: "LoanPay",
        Account: borrower.address,
        LoanID: loanId,
        Amount: payAmount,
      },
      borrower,
    );
    record("LoanPay", pay.hash);
    vault = await readVault(client, vaultId);
    console.log(
      `  after repayment: AssetsTotal=${vault.AssetsTotal} AssetsAvailable=${vault.AssetsAvailable}`,
    );
    assert(
      BigInt(vault.AssetsTotal) > BigInt(depositDrops),
      `yield realized: AssetsTotal ${vault.AssetsTotal} > deposit ${depositDrops}`,
    );
    assert(
      vault.AssetsAvailable === vault.AssetsTotal,
      `all assets liquid again after repayment`,
    );

    // ---- Step 4: VaultWithdraw (lender redeems all shares) ----
    // Pass the SHARE MPT amount to redeem shares (burn all shares, receive the
    // assets they are worth = AssetsTotal). A bare XRP drops Amount would instead
    // withdraw that many drops of ASSET and leave the yield behind.
    const shares = await shareBalance(client, lender.address, shareMptId);
    const withdraw = await submitAndWait(
      client,
      {
        TransactionType: "VaultWithdraw",
        Account: lender.address,
        VaultID: vaultId,
        Amount: { mpt_issuance_id: shareMptId, value: shares },
      },
      lender,
    );
    record("VaultWithdraw", withdraw.hash);

    // Gross payout = assets the vault released = decrease of the vault
    // pseudo-account balance in this tx. (The lender's own balance delta would
    // also subtract the tx fee, which is a cost of transacting, not a vault loss.)
    const payoutDrops = balanceDecrease(withdraw.meta, vault.Account);
    console.log(
      `  redeemed shares=${shares} vault payout=${payoutDrops} drops (deposit was ${depositDrops})`,
    );
    assert(
      BigInt(payoutDrops) > BigInt(depositDrops),
      `withdraw pays MORE than deposit (${payoutDrops} > ${depositDrops})`,
    );

    console.log(
      `\nLender gain on redemption: ${dropsToXrp((BigInt(payoutDrops) - BigInt(depositDrops)).toString())} XRP` +
        ` (real loan interest, derived from share price, not a stored field)`,
    );
    console.log("\nExplorer links:\n" + links.join("\n"));
    console.log("\nPhase 1.1 complete: share value rose from real loan interest.");
  } finally {
    await client.disconnect();
  }
}

// Drops by which `account`'s XRP balance DECREASED in this tx (before - after).
function balanceDecrease(meta, account) {
  for (const n of meta.AffectedNodes || []) {
    const m = n.ModifiedNode;
    if (m?.LedgerEntryType === "AccountRoot" && m.FinalFields?.Account === account) {
      const before = BigInt(m.PreviousFields?.Balance ?? m.FinalFields.Balance);
      const after = BigInt(m.FinalFields.Balance);
      return (before - after).toString();
    }
  }
  return "0";
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  assert ok: ${msg}`);
}

main().catch((e) => {
  logFriction({ phase: "1.1", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
