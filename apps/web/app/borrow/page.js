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
import { roundUpToAssetUnit, formatRippleTime, formatDuration } from "../../lib/format";
import { getClient } from "../../lib/xrpl-client";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { CheckCircle2, XCircle } from "lucide-react";

const POLL_MS = 6000;
// The shortest term the desk offers, in 6 payments. Also the first thing the picker shows.
const DEFAULT_TERM = { termId: "1d", payments: 6 };
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
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
  const [quoted, setQuoted] = useState(null);
  const [termId, setTermId] = useState(DEFAULT_TERM.termId);
  const [payments, setPayments] = useState(DEFAULT_TERM.payments);
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

  // The desk prices and sizes the loan before you type an amount, so the limit is visible
  // instead of arriving as a rejection after you have signed. It is only a preview: the
  // desk re-derives the same decision from the ledger when the signed loan comes back.
  const refreshQuote = useCallback(async () => {
    if (!address || market.operator !== DESK_OPERATOR) return;
    const brokerId = market.brokerId;
    try {
      const r = await fetch("/api/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brokerId, borrower: address }),
      });
      const d = await r.json();
      setQuoted({ brokerId, ...d });
    } catch (e) {
      setQuoted({ brokerId, error: e instanceof Error ? e.message : String(e) });
    }
  }, [address, market.operator, market.brokerId]);

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
      // Utilisation moves the rate, so the quote is refreshed with the pool.
      if (loanId) refreshLoan(loanId);
      else refreshQuote();
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [market, loanId, refreshLoan, refreshQuote]);

  // Only the desk can add the LoanSet counterparty signature (its key is server-side).
  const deskOperated = market.operator === DESK_OPERATOR;
  const available = vault ? big(vault.AssetsAvailable) : 0n;
  // A quote is only this market's quote; switching markets drops it until the new one lands.
  const thisMarket = quoted?.brokerId === market.brokerId ? quoted : null;
  const quote = thisMarket?.error ? null : thisMarket;
  const quoteError = thisMarket?.error || null;

  // The borrower picks how long to repay over and how many payments to make in that time.
  // Not every pairing is possible (the ledger needs an interval of at least 60s), so the
  // payment choices come from what the desk actually quoted for the chosen term.
  const terms = quote?.options ? [...new Map(quote.options.map((o) => [o.termId, o.termLabel])).entries()] : [];
  const countsForTerm = quote?.options ? quote.options.filter((o) => o.termId === termId) : [];
  const option =
    quote?.options?.find((o) => o.termId === termId && o.payments === payments) ||
    quote?.options?.find((o) => o.termId === termId) ||
    quote?.options?.[0] ||
    null;
  const maxDraw = option ? big(option.maxPrincipal) : 0n;
  const amountValid = (() => {
    try {
      const d = big(toBaseUnits(asset, amount));
      return d > 0n && d <= maxDraw;
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
        // Schedule and rate both come from the option the borrower picked, so the loan is
        // built from what the desk just quoted rather than from anything this browser
        // remembers. The desk re-derives its menu and refuses to co-sign a schedule it
        // does not offer, or a rate under the floor for that schedule.
        ...option.schedule,
        InterestRate: option.rate,
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
        refreshQuote();
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
                {quote && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="term">Repay over</Label>
                      <select id="term" className={SELECT_CLASS} value={option?.termId ?? termId}
                        onChange={(e) => setTermId(e.target.value)}>
                        {terms.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="pay-count">In</Label>
                      <select id="pay-count" className={SELECT_CLASS} value={String(option?.payments ?? payments)}
                        onChange={(e) => setPayments(Number(e.target.value))}>
                        {countsForTerm.map((o) => (
                          <option key={o.payments} value={o.payments}>
                            {o.payments} payment{o.payments === 1 ? "" : "s"} (every {formatDuration(o.schedule.PaymentInterval)})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {option && maxDraw > 0n && (
                  <div className="space-y-2 rounded-lg border border-border/60 p-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Your rate</span>
                      <span className="font-semibold tabular-nums">{(option.rate / 1000).toFixed(2)}% APR</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">You can draw up to</span>
                      <span className="font-semibold tabular-nums">{formatAmount(asset, option.maxPrincipal)} {sym}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {option.payments} payment{option.payments === 1 ? "" : "s"}, one every {formatDuration(option.schedule.PaymentInterval)},
                      with {formatDuration(option.schedule.GracePeriod)} of grace on each. {option.reason}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {quote.tier}{quote.verified ? ", verified for this market" : ""} · {quote.repaid} loan{quote.repaid === 1 ? "" : "s"} repaid
                      {big(option.collateral) > 0n ? ` · ${formatAmount(asset, option.collateral)} ${sym} collateral posted` : ""}.
                      The market charges {(quote.marketRate / 1000).toFixed(2)}% at {(quote.utilBps / 100).toFixed(0)}% utilisation;
                      the rest is your borrower spread and the premium for a longer loan.
                    </p>
                  </div>
                )}
                {option && maxDraw === 0n && (
                  <Alert variant="warning">
                    <AlertTitle>The desk won’t lend to you here right now</AlertTitle>
                    <AlertDescription>{option.reason}</AlertDescription>
                  </Alert>
                )}
                {quoteError && (
                  <Alert variant="warning">
                    <AlertTitle>No quote</AlertTitle>
                    <AlertDescription>{quoteError}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="amt">Amount to borrow ({sym})</Label>
                    <span className="text-xs text-muted-foreground">Pool has {formatAmount(asset, available)} {sym} idle</span>
                  </div>
                  <Input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0.00" />
                </div>
                <p className="text-xs text-muted-foreground">Repaid in installments with interest. You can pay off early any time.</p>
                <Button className="w-full" disabled={!isConnected || !amountValid || busy || !deskOperated || !option} onClick={handleBorrow}>
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
                <CardContent className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-5">
                  <Stat label="Outstanding" value={`${formatAmount(asset, loan.PrincipalOutstanding)} ${sym}`} />
                  <Stat label="Rate" value={`${(Number(loan.InterestRate ?? 0) / 1000).toFixed(2)}%`} sub="APR, fixed for this loan" />
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

          <CollateralPanel market={market} />
        </div>
  );
}
