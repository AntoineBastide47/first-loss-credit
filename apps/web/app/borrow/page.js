"use client";

// Borrow: request a loan from a credit vault (XRP or MPT-denominated) and repay it. The
// borrower signs the loan in their wallet; the protocol co-signs server-side (no seeds
// in the browser). Repayments are a single signature. Amounts follow the market's asset.

import { useCallback, useEffect, useState } from "react";
import { LoanPayFlags, encode, decode } from "xrpl";
import { MarketSelect } from "../../components/MarketSelect";
import { CollateralPanel } from "../../components/CollateralPanel";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKETS, DESK_OPERATOR } from "../../lib/market";
import { marketVault, loadMyLoan, saveMyLoan } from "../../lib/product";
import { readLoan, borrowerLoans, isSettled } from "../../lib/lending-read";
import { assetSymbol, formatAmount, toBaseUnits, assetAmount } from "../../lib/asset";
import { roundUpToAssetUnit, formatRippleTime } from "../../lib/format";
import { getClient } from "../../lib/xrpl-client";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { CheckCircle2, XCircle } from "lucide-react";

const POLL_MS = 6000;
const big = (v) => BigInt(v ?? "0");
const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;

/**
 * A borrower-signed LoanSet blob the desk can counter-sign.
 *
 * Wallet adapters disagree on what `sign()` returns in `tx_blob`: Crossmark gives a real
 * serialized blob, while WalletConnect and GemWallet return only the bare signature. The
 * WalletConnect adapter does have the full signed tx_json (it autofills, so its copy is
 * the one that was actually signed) and merely discards it, so prefer that when present.
 * Otherwise fall back to the blob, and last of all rebuild one from the signature.
 */
async function signLoanSet(walletManager, tx) {
  const adapter = walletManager?.wallet;
  if (typeof adapter?.requestSignTransaction === "function") {
    const signedJson = await adapter.requestSignTransaction(tx, false);
    if (signedJson?.TxnSignature) return encode(signedJson);
  }
  const signed = await walletManager.sign(tx);
  const candidate = signed?.tx_blob ?? signed;
  if (typeof candidate === "string") {
    try {
      if (decode(candidate)?.TransactionType) return candidate; // already a full blob
    } catch {
      // not a blob: treat it as a bare signature below
    }
  }
  const publicKey = walletManager?.account?.publicKey;
  if (typeof candidate === "string" && publicKey) {
    return encode({ ...tx, SigningPubKey: publicKey, TxnSignature: candidate });
  }
  throw new Error("This wallet returned a signature this app cannot assemble into a transaction.");
}

function Stat({ label, value, sub }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default function BorrowPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [market, setMarket] = useState(MARKETS[0]);
  const asset = market.asset;
  const sym = assetSymbol(asset);

  const [vault, setVault] = useState(null);
  const [loanId, setLoanId] = useState(null);
  const [loan, setLoan] = useState(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [justRepaid, setJustRepaid] = useState(false);

  const refreshLoan = useCallback(async (id) => {
    if (!id) return;
    try {
      const fresh = await readLoan(id);
      // A repaid loan lingers on the ledger with empty balances; retire it so the borrow
      // form comes back instead of offering a payment on a closed loan.
      if (isSettled(fresh)) {
        if (address) saveMyLoan(market, address, null);
        setLoan(null);
        setLoanId(null);
        setJustRepaid(true);
        return;
      }
      setLoan(fresh);
    } catch {
      // The loan may be closed/settled; forget it so the borrow form returns.
      if (address) saveMyLoan(market, address, null);
      setLoan(null);
      setLoanId(null);
    }
  }, [market, address]);

  // Your active loan comes from the ledger (loans live in the borrower's owner directory),
  // so it shows up on any device. The remembered id is only a first guess.
  useEffect(() => {
    let on = true;
    setLoan(null);
    setJustRepaid(false);
    setLoanId(address ? loadMyLoan(market, address) : null);
    if (!address) return undefined;
    borrowerLoans(address)
      .then((list) => {
        if (!on) return;
        const mine = list.find((x) => x.loan?.LoanBrokerID === market.brokerId && !isSettled(x.loan));
        if (mine) {
          setLoanId(mine.id);
          setLoan(mine.loan);
          saveMyLoan(market, address, mine.id);
        }
      })
      .catch(() => {});
    return () => { on = false; };
  }, [market, address]);

  useEffect(() => {
    let on = true;
    const tick = () => {
      marketVault(market).then((v) => on && setVault(v)).catch(() => {});
      if (loanId) refreshLoan(loanId);
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [market, loanId, refreshLoan]);

  // Only the desk can add the LoanSet counterparty signature (its key is server-side).
  const deskOperated = market.operator === DESK_OPERATOR;
  const available = vault ? big(vault.AssetsAvailable) : 0n;
  const amountValid = (() => {
    try {
      const d = big(toBaseUnits(asset, amount));
      return d > 0n && d <= available;
    } catch {
      return false;
    }
  })();

  async function handleBorrow() {
    setBusy(true);
    setOutcome(null);
    try {
      const client = await getClient();
      const tx = await client.autofill({
        TransactionType: "LoanSet",
        Account: address,
        Counterparty: market.operator,
        LoanBrokerID: market.brokerId,
        PrincipalRequested: toBaseUnits(asset, amount),
        ...market.loanTerms,
      });
      const borrowerBlob = await signLoanSet(walletManager, tx);
      const resp = await fetch("/api/originate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ borrowerBlob, marketId: market.id }),
      });
      const data = await resp.json();
      if (data.code === "tesSUCCESS" && data.loanId) {
        saveMyLoan(market, address, data.loanId);
        setLoanId(data.loanId);
        setAmount("");
        setOutcome({ ok: true });
        refreshLoan(data.loanId);
      } else {
        setOutcome({ error: data.error || explain("LoanSet", data.code) || "Could not create the loan." });
      }
    } catch (e) {
      setOutcome({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const overdue = loan && rippleNow() > Number(loan.NextPaymentDueDate ?? 0);
  const remaining = loan ? Number(loan.PaymentRemaining ?? 0) : 0;

  const onRepaid = useCallback(() => {
    if (loanId) refreshLoan(loanId);
  }, [loanId, refreshLoan]);

  return (
        <div className="container max-w-2xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Borrow {sym}</h1>
            <p className="mt-1 text-muted-foreground">
              Draw a loan from the {market.name} and repay it over time. You sign; the desk approves
              instantly.
            </p>
          </div>

          {/* Always switchable: hiding this while a loan is open trapped you on that market. */}
          <MarketSelect value={market} onChange={setMarket} />

          {!loan && !deskOperated && (
            <Alert variant="warning">
              <AlertTitle>This vault can’t originate loans here</AlertTitle>
              <AlertDescription>
                {market.name} is owned by {market.operator === address ? "you" : "another account"}, not the desk. A loan needs the
                vault owner’s counter-signature, which uses a signing scheme browser wallets don’t
                expose, so only desk-run markets can fund a loan in this app. You can still deposit
                into this vault on Earn.
              </AlertDescription>
            </Alert>
          )}

          {!loan && justRepaid && (
            <Alert variant="success">
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>Loan repaid</AlertTitle>
              <AlertDescription>That loan is fully settled. You can borrow again below.</AlertDescription>
            </Alert>
          )}

          {!loan && (
            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="amt">Amount to borrow ({sym})</Label>
                    <span className="text-xs text-muted-foreground">Available: {formatAmount(asset, available)} {sym}</span>
                  </div>
                  <Input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0.00" />
                </div>
                <p className="text-xs text-muted-foreground">Repaid in 6 installments with interest. You can pay off early any time.</p>
                <Button className="w-full" disabled={!isConnected || !amountValid || busy || !deskOperated} onClick={handleBorrow}>
                  {busy ? "Awaiting signature…" : "Borrow"}
                </Button>
                {!isConnected && <p className="text-xs text-muted-foreground">Connect a wallet to borrow.</p>}
                {outcome?.error && (
                  <Alert variant="destructive">
                    <XCircle className="h-4 w-4" />
                    <AlertTitle>Didn’t go through</AlertTitle>
                    <AlertDescription className="break-all">{outcome.error}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
          )}

          {loan && (
            <>
              {outcome?.ok && (
                <Alert variant="success">
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Loan funded</AlertTitle>
                  <AlertDescription>The {sym} is in your wallet. Repay below.</AlertDescription>
                </Alert>
              )}
              <Card>
                <CardContent className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-4">
                  <Stat label="Outstanding" value={`${formatAmount(asset, loan.PrincipalOutstanding)} ${sym}`} />
                  <Stat label="Total to repay" value={`${formatAmount(asset, roundUpToAssetUnit(loan.TotalValueOutstanding))} ${sym}`} />
                  <Stat label="Next payment" value={`${formatAmount(asset, roundUpToAssetUnit(loan.PeriodicPayment))} ${sym}`} sub={overdue ? "overdue" : `due ${formatRippleTime(loan.NextPaymentDueDate)}`} />
                  <Stat label="Payments left" value={String(remaining)} />
                </CardContent>
              </Card>

              <div className="grid gap-6 sm:grid-cols-2">
                <Card>
                  <CardContent className="space-y-3 p-6">
                    <h2 className="font-medium">Make a payment</h2>
                    <p className="text-xs text-muted-foreground">Pay this period’s installment{overdue ? " (marked late)" : ""}.</p>
                    <TxButton
                      label={`Pay ${formatAmount(asset, roundUpToAssetUnit(loan.PeriodicPayment))} ${sym}`}
                      explain={explain}
                      disabled={!isConnected}
                      tx={() => {
                        const t = { TransactionType: "LoanPay", Account: address, LoanID: loanId, Amount: assetAmount(asset, roundUpToAssetUnit(loan.PeriodicPayment)) };
                        if (overdue) t.Flags = LoanPayFlags.tfLoanLatePayment;
                        return t;
                      }}
                      onResult={onRepaid}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="space-y-3 p-6">
                    <h2 className="font-medium">Pay off in full</h2>
                    <p className="text-xs text-muted-foreground">Clear the loan now and stop the interest.</p>
                    <TxButton
                      label={`Pay off ${formatAmount(asset, roundUpToAssetUnit(loan.TotalValueOutstanding))} ${sym}`}
                      variant="outline"
                      explain={explain}
                      disabled={!isConnected}
                      tx={() => {
                        const t = { TransactionType: "LoanPay", Account: address, LoanID: loanId, Amount: assetAmount(asset, roundUpToAssetUnit(loan.TotalValueOutstanding)) };
                        let flags = 0;
                        if (remaining > 1) flags |= LoanPayFlags.tfLoanFullPayment;
                        if (overdue) flags |= LoanPayFlags.tfLoanLatePayment;
                        if (flags) t.Flags = flags;
                        return t;
                      }}
                      onResult={onRepaid}
                    />
                  </CardContent>
                </Card>
              </div>
            </>
          )}

          <CollateralPanel />
        </div>
  );
}
