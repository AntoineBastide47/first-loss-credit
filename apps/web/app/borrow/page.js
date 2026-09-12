"use client";

// Borrow: request a loan from the First-Loss Credit Vault and repay it. The borrower
// signs the loan in their wallet; the protocol co-signs server-side (no seeds in the
// browser). Repayments are a single signature. Human XRP throughout.

import { useCallback, useEffect, useState } from "react";
import { xrpToDrops, LoanPayFlags } from "xrpl";
import { Header } from "../../components/Header";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKET } from "../../lib/market";
import { marketVault, loadMyLoan, saveMyLoan, addKnownLoan } from "../../lib/product";
import { readLoan } from "../../lib/lending-read";
import { formatDrops, groupThousands, roundUpToAssetUnit, formatRippleTime } from "../../lib/format";
import { getClient } from "../../lib/xrpl-client";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { CheckCircle2, XCircle } from "lucide-react";

const POLL_MS = 6000;
const xrp = (drops) => groupThousands(formatDrops(String(drops ?? "0")));
const big = (v) => BigInt(v ?? "0");
const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;

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

  const [vault, setVault] = useState(null);
  const [loanId, setLoanId] = useState(null);
  const [loan, setLoan] = useState(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const refreshLoan = useCallback(async (id) => {
    if (!id) return;
    try {
      setLoan(await readLoan(id));
    } catch {
      // The loan may be closed/settled; forget it so the borrow form returns.
      if (address) saveMyLoan(address, null);
      setLoan(null);
      setLoanId(null);
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    const id = loadMyLoan(address);
    setLoanId(id);
  }, [address]);

  useEffect(() => {
    let on = true;
    const tick = () => {
      marketVault().then((v) => on && setVault(v)).catch(() => {});
      if (loanId) refreshLoan(loanId);
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [loanId, refreshLoan]);

  const available = vault ? big(vault.AssetsAvailable) : 0n;
  const amountValid = (() => {
    try {
      const d = big(xrpToDrops(amount));
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
        Counterparty: MARKET.operator,
        LoanBrokerID: MARKET.brokerId,
        PrincipalRequested: xrpToDrops(amount),
        ...MARKET.loanTerms,
      });
      const signed = await walletManager.sign(tx);
      const borrowerBlob = signed?.tx_blob ?? signed;
      const resp = await fetch("/api/originate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ borrowerBlob }),
      });
      const data = await resp.json();
      if (data.code === "tesSUCCESS" && data.loanId) {
        saveMyLoan(address, data.loanId);
        addKnownLoan(data.loanId);
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
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-2xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Borrow XRP</h1>
            <p className="mt-1 text-muted-foreground">
              Draw a loan from the {MARKET.name} and repay it over time. You sign; the desk approves
              instantly.
            </p>
          </div>

          {!loan && (
            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="amt">Amount to borrow (XRP)</Label>
                    <span className="text-xs text-muted-foreground">Available: {xrp(available)} XRP</span>
                  </div>
                  <Input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0.00" />
                </div>
                <p className="text-xs text-muted-foreground">Repaid in 6 installments with interest. You can pay off early any time.</p>
                <Button className="w-full" disabled={!isConnected || !amountValid || busy} onClick={handleBorrow}>
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
                  <AlertDescription>The XRP is in your wallet. Repay below.</AlertDescription>
                </Alert>
              )}
              <Card>
                <CardContent className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-4">
                  <Stat label="Outstanding" value={`${xrp(loan.PrincipalOutstanding)} XRP`} />
                  <Stat label="Total to repay" value={`${xrp(roundUpToAssetUnit(loan.TotalValueOutstanding))} XRP`} />
                  <Stat label="Next payment" value={`${xrp(roundUpToAssetUnit(loan.PeriodicPayment))} XRP`} sub={overdue ? "overdue" : `due ${formatRippleTime(loan.NextPaymentDueDate)}`} />
                  <Stat label="Payments left" value={String(remaining)} />
                </CardContent>
              </Card>

              <div className="grid gap-6 sm:grid-cols-2">
                <Card>
                  <CardContent className="space-y-3 p-6">
                    <h2 className="font-medium">Make a payment</h2>
                    <p className="text-xs text-muted-foreground">Pay this period’s installment{overdue ? " (marked late)" : ""}.</p>
                    <TxButton
                      label={`Pay ${xrp(roundUpToAssetUnit(loan.PeriodicPayment))} XRP`}
                      explain={explain}
                      disabled={!isConnected}
                      tx={() => {
                        const t = { TransactionType: "LoanPay", Account: address, LoanID: loanId, Amount: roundUpToAssetUnit(loan.PeriodicPayment) };
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
                      label={`Pay off ${xrp(roundUpToAssetUnit(loan.TotalValueOutstanding))} XRP`}
                      variant="outline"
                      explain={explain}
                      disabled={!isConnected}
                      tx={() => {
                        const t = { TransactionType: "LoanPay", Account: address, LoanID: loanId, Amount: roundUpToAssetUnit(loan.TotalValueOutstanding) };
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
        </div>
      </main>
    </div>
  );
}
