// Shared, non-phase helpers for the first-loss-credit plan.
// No phase-specific state lives here. Every phase may call these.
//
// Network: the Lending Hackathon devnet. XLS-65/66 amendments (SingleAssetVault,
// LendingProtocol, LendingProtocolV1_1, PermissionedDomains, TokenEscrow,
// MPTokensV1) are all enabled (verified 2026-09-12: build 3.4.0-rc1, network
// 4001, reserves 10/2 XRP). Override with XRPL_WSS / XRPL_FAUCET.

import { Client, Wallet, dropsToXrp, encode, decode, encodeForSigning } from "xrpl";
import { sign as keypairSign } from "ripple-keypairs";

export const NETWORK = {
  wss: process.env.XRPL_WSS || "wss://lending-hackathon.dev.ripplex.io:51233",
  // Faucet POST with an empty body returns { account: { address, secret }, balance }.
  // It generates and funds its own account (ignores destination), so fund by
  // building a Wallet from the returned secret.
  faucet: process.env.XRPL_FAUCET || "https://lending-hackathon-faucet.dev.ripplex.io/accounts",
  explorerBase: process.env.XRPL_EXPLORER || "https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233",
};

// Amendments a full first-loss-credit run depends on. connect() asserts these.
const REQUIRED_AMENDMENTS = ["SingleAssetVault", "LendingProtocol"];

/** Open and return a connected client. Assert the lending amendments are enabled. */
export async function connect() {
  const client = new Client(NETWORK.wss, { connectionTimeout: 20000 });
  await client.connect();
  const { result } = await client.request({ command: "feature" });
  const feats = result.features || {};
  const enabled = new Set(
    Object.values(feats).filter((f) => f.enabled).map((f) => f.name),
  );
  const missing = REQUIRED_AMENDMENTS.filter((a) => !enabled.has(a));
  if (missing.length) {
    await client.disconnect();
    throw new Error(
      `Network ${NETWORK.wss} is missing required amendments: ${missing.join(", ")}. ` +
        `Point XRPL_WSS at a network where XLS-65/66 is enabled.`,
    );
  }
  return client;
}

/**
 * Create and fund `n` accounts from the hackathon faucet, then wait until each is
 * present on a validated ledger. Returns an array of funded Wallet objects.
 * Bounded loops.
 */
export async function fundAccounts(client, n) {
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw new Error(`fundAccounts: n must be 1..16, got ${n}`);
  }
  const wallets = [];
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(NETWORK.faucet, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`faucet ${NETWORK.faucet} returned HTTP ${res.status}`);
    const { account } = await res.json();
    if (!account?.secret) throw new Error(`faucet response missing account.secret`);
    wallets.push(Wallet.fromSeed(account.secret));
  }
  // Wait until every new account is on a validated ledger.
  const deadline = Date.now() + 30000;
  for (const w of wallets) {
    for (let guard = 0; guard < 60; guard += 1) {
      try {
        await client.request({
          command: "account_info",
          account: w.classicAddress,
          ledger_index: "validated",
        });
        break;
      } catch (e) {
        if (Date.now() > deadline) {
          throw new Error(`fundAccounts: ${w.classicAddress} not validated in time`);
        }
        await sleep(1000);
      }
    }
  }
  return wallets;
}

/**
 * Autofill, sign with `wallet`, submit, and wait for a validated ledger.
 * `extraSigners` is an ordered list of { wallet } counterparties that must add a
 * LoanSet CounterpartySignature via signLoanSetByCounterparty (see submitLoanSet).
 * Throws on any non-tesSUCCESS engine result. Returns { hash, meta, result }.
 */
export async function submitAndWait(client, tx, wallet) {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob);
  const code = res.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") {
    throw new SubmitError(tx.TransactionType, code, res.result.hash, res);
  }
  return { hash: res.result.hash, meta: res.result.meta, result: res.result };
}

// HashPrefix values (4 bytes each) used as the first word of the signing data.
const STX_PREFIX = "53545800"; // 'S','T','X',0 — standard single-sig (HashPrefix::TxSign)
const CPT_PREFIX = "43505400"; // 'C','P','T',0 — counterparty (HashPrefix::CounterpartyTxSign)

/**
 * Add a LoanSet CounterpartySignature.
 *
 * rippled verifies this signature over CounterpartyTxSign('CPT') || tx-without-
 * signature-fields. xrpl@5.1.0's signLoanSetByCounterparty signs with the standard
 * 'STX' prefix, which the hackathon rippled (3.4.0-rc1) rejects as an invalid
 * signature. This helper reuses encodeForSigning (identical body) and swaps only
 * the 4-byte prefix, so it matches rippled exactly.
 *
 * `firstPartySigned` is the LoanSet already signed by Account (blob or object).
 */
export function signLoanSetCounterparty(firstPartySigned, counterpartyWallet) {
  const obj = typeof firstPartySigned === "string" ? decode(firstPartySigned) : { ...firstPartySigned };
  if (!obj.SigningPubKey || !obj.TxnSignature) {
    throw new Error("signLoanSetCounterparty: Account must sign before the counterparty");
  }
  if (obj.CounterpartySignature) {
    throw new Error("signLoanSetCounterparty: already counterparty-signed");
  }
  const stdHex = encodeForSigning(obj);
  if (!stdHex.startsWith(STX_PREFIX)) {
    throw new Error(`signLoanSetCounterparty: unexpected signing prefix ${stdHex.slice(0, 8)}`);
  }
  const cptHex = CPT_PREFIX + stdHex.slice(STX_PREFIX.length);
  obj.CounterpartySignature = {
    SigningPubKey: counterpartyWallet.publicKey,
    TxnSignature: keypairSign(cptHex, counterpartyWallet.privateKey),
  };
  return { tx_blob: encode(obj), tx: obj };
}

/** Raised on a non-success engine result so callers can assert exact codes. */
export class SubmitError extends Error {
  constructor(txType, code, hash, res) {
    super(`${txType} failed: ${code} (${hash})`);
    this.name = "SubmitError";
    this.txType = txType;
    this.code = code;
    this.hash = hash;
    this.res = res;
  }
}

/**
 * Submit a call and return the engine result WITHOUT throwing on tec/tem codes.
 * Use for negative controls (guardrail rejections) where a failure is expected.
 */
export async function submitExpectingFailure(client, tx, wallet) {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob).catch((e) => e);
  const code =
    res?.result?.meta?.TransactionResult || res?.data?.error || res?.message || "unknown";
  return { code, hash: res?.result?.hash, res };
}

/**
 * Submit an ALREADY-SIGNED tx blob and return the engine result WITHOUT throwing on
 * a tec/tem code. Use for negative controls on a pre-signed transaction (e.g. a
 * dual-signed LoanSet) where re-autofilling/re-signing would be wrong.
 */
export async function submitSignedExpectingFailure(client, txBlob) {
  const res = await client.submitAndWait(txBlob).catch((e) => e);
  const code =
    res?.result?.meta?.TransactionResult || res?.data?.error || res?.message || "unknown";
  return { code, hash: res?.result?.hash, res };
}

/** Advance `n` validated ledgers by polling ledger_current_index. Bounded wait. */
export async function waitLedgers(client, n) {
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error(`waitLedgers: n must be 1..200, got ${n}`);
  }
  const start = (await client.request({ command: "ledger", ledger_index: "validated" }))
    .result.ledger_index;
  const target = start + n;
  const deadline = Date.now() + n * 15000 + 30000;
  // Bounded: each iteration waits for the next validated ledger or times out.
  for (let guard = 0; guard < 10000; guard += 1) {
    const cur = (await client.request({ command: "ledger", ledger_index: "validated" }))
      .result.ledger_index;
    if (cur >= target) return cur;
    if (Date.now() > deadline) {
      throw new Error(`waitLedgers: timeout waiting for ${n} ledgers (at ${cur}/${target})`);
    }
    await sleep(1500);
  }
  throw new Error("waitLedgers: guard exceeded");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until a validated ledger's close time is strictly greater than `rippleTime`
 * (seconds since the Ripple epoch, 2000-01-01), then return that close time. Used
 * for loan impair/default windows, which gate on ledger time, not ledger count.
 * Bounded by `maxSeconds` (default 240s) of real wait.
 */
export async function waitUntilAfter(client, rippleTime, maxSeconds = 240) {
  const deadline = Date.now() + maxSeconds * 1000;
  for (let guard = 0; guard < 10000; guard += 1) {
    const { result } = await client.request({ command: "ledger", ledger_index: "validated" });
    const closeTime = result.ledger.close_time;
    if (closeTime > rippleTime) return closeTime;
    if (Date.now() > deadline) {
      throw new Error(`waitUntilAfter: ledger time ${closeTime} did not pass ${rippleTime} in ${maxSeconds}s`);
    }
    await sleep(2000);
  }
  throw new Error("waitUntilAfter: guard exceeded");
}

/**
 * Round a high-precision loan figure UP to a whole asset base unit.
 *
 * Verified on the hackathon network: loan fields (PeriodicPayment,
 * TotalValueOutstanding, ...) are ALREADY denominated in the asset's base unit
 * (drops for an XRP vault, 10^-AssetScale units for an MPT vault) and carry a
 * fractional part, e.g. "20000038.05174906852" drops. A payment must be a whole
 * base unit, so round this UP to the next integer. The asset arg is accepted for
 * call-site clarity but the rounding is always ceil-to-integer.
 *
 * `value` is a decimal string or number; returns an integer base-unit string.
 */
export function roundUpToAssetUnit(value, _asset) {
  const decStr = typeof value === "string" ? value : String(value);
  const neg = decStr.startsWith("-");
  const s = neg ? decStr.slice(1) : decStr;
  const [intPart, fracPart = ""] = s.split(".");
  let base = BigInt(intPart);
  if (!neg && /[1-9]/.test(fracPart)) base += 1n; // round up on any fractional remainder
  return (neg ? "-" : "") + base.toString();
}

/** Fetch the Vault ledger object via vault_info. */
export async function readVault(client, vaultId) {
  const { result } = await client.request({ command: "vault_info", vault_id: vaultId });
  return result.vault;
}

/** Fetch a ledger object by index (LoanBroker / Loan). Returns the node. */
export async function readLedgerEntry(client, index) {
  const { result } = await client.request({ command: "ledger_entry", index });
  return result.node;
}

export const readLoanBroker = (client, index) => readLedgerEntry(client, index);
export const readLoan = (client, index) => readLedgerEntry(client, index);

/** Explorer URL for a tx hash or account address. */
export function explorer(hashOrAccount) {
  const kind = /^[0-9A-Fa-f]{64}$/.test(hashOrAccount) ? "transactions" : "accounts";
  return `${NETWORK.explorerBase}/${kind}/${hashOrAccount}`;
}

/** Append a structured friction note to the run log (stdout; DevEx report picks it up). */
export function logFriction(entry) {
  const line = typeof entry === "string" ? entry : JSON.stringify(entry);
  console.log(`[friction] ${line}`);
}

export { Wallet, dropsToXrp };
