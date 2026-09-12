"use client";

// Dev-only demo seeder. Builds a vault + broker + loan on the devnet so a screen
// has something to read when no ids are supplied. It is infrastructure, not a
// phase: it builds the same protocol shapes a screen would, and no screen imports
// another phase to obtain ids. Gate it behind the `?demo` flag (isDemoEnabled).
//
// Secrets: the faucet returns funded account secrets. They are built into in-memory
// Wallets and used only on the local signing path; they are never logged or sent
// anywhere but the submit call to the devnet.

import { Wallet, VaultWithdrawalPolicy, signLoanSetByCounterparty } from "xrpl";
import { getClient } from "./xrpl-client";
import { DEFAULT_NETWORK } from "./networks";

/** True when the page URL carries `?demo` (client-side only). */
export function isDemoEnabled() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("demo");
}

function createdIndex(meta, entryType) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === entryType) return c.LedgerIndex;
  }
  throw new Error(`seedScenario: no created ${entryType} in metadata`);
}

async function fundAccount(client) {
  const res = await fetch(DEFAULT_NETWORK.faucet, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`faucet HTTP ${res.status}`);
  const { account } = await res.json();
  if (!account?.secret) throw new Error("faucet response missing account.secret");
  const wallet = Wallet.fromSeed(account.secret);
  // Wait until the new account is on a validated ledger (bounded).
  for (let guard = 0; guard < 40; guard += 1) {
    try {
      await client.request({
        command: "account_info",
        account: wallet.classicAddress,
        ledger_index: "validated",
      });
      return wallet;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`seedScenario: ${wallet.classicAddress} not validated in time`);
}

async function submit(client, tx, wallet) {
  const signed = wallet.sign(await client.autofill(tx));
  const res = await client.submitAndWait(signed.tx_blob);
  const code = res.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`${tx.TransactionType} failed: ${code}`);
  return res.result;
}

/**
 * Seed one healthy vault/broker/loan and return the ids a screen needs.
 * Returns { vaultId, shareMptId, brokerId, loanId, accounts: { owner, lender, borrower } }.
 * Accounts are classic addresses only; secrets never leave this function.
 */
export async function seedScenario() {
  const client = await getClient();
  const owner = await fundAccount(client);
  const lender = await fundAccount(client);
  const borrower = await fundAccount(client);

  const vaultRes = await submit(client, {
    TransactionType: "VaultCreate",
    Account: owner.address,
    Asset: { currency: "XRP" },
    WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
  }, owner);
  const vaultId = createdIndex(vaultRes.meta, "Vault");
  const { result: vaultInfo } = await client.request({ command: "vault_info", vault_id: vaultId });
  const shareMptId = vaultInfo.vault.ShareMPTID;

  await submit(client, {
    TransactionType: "VaultDeposit",
    Account: lender.address,
    VaultID: vaultId,
    Amount: "40000000",
  }, lender);

  const brokerRes = await submit(client, {
    TransactionType: "LoanBrokerSet",
    Account: owner.address,
    VaultID: vaultId,
    ManagementFeeRate: 0,
    DebtMaximum: "1000000000",
    CoverRateMinimum: 10000,
    CoverRateLiquidation: 20000,
  }, owner);
  const brokerId = createdIndex(brokerRes.meta, "LoanBroker");

  await submit(client, {
    TransactionType: "LoanBrokerCoverDeposit",
    Account: owner.address,
    LoanBrokerID: brokerId,
    Amount: "10000000",
  }, owner);

  const loanTx = await client.autofill({
    TransactionType: "LoanSet",
    Account: borrower.address,
    Counterparty: owner.address,
    LoanBrokerID: brokerId,
    PrincipalRequested: "20000000",
    InterestRate: 100000,
    PaymentInterval: 60,
    PaymentTotal: 1,
    GracePeriod: 60,
  });
  const dualSigned = signLoanSetByCounterparty(owner, borrower.sign(loanTx).tx_blob).tx_blob;
  const loanRes = await client.submitAndWait(dualSigned);
  if (loanRes.result.meta?.TransactionResult !== "tesSUCCESS") {
    throw new Error(`LoanSet failed: ${loanRes.result.meta?.TransactionResult}`);
  }
  const loanId = createdIndex(loanRes.result.meta, "Loan");

  return {
    vaultId,
    shareMptId,
    brokerId,
    loanId,
    accounts: { owner: owner.address, lender: lender.address, borrower: borrower.address },
  };
}
