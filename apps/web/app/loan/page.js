"use client";

// Phase 6.3 — Loan Desk. Originate a loan with the two-party LoanSet (borrower
// TxnSignature + owner CounterpartySignature) and run repayments from the
// browser. Independent of every other UI/backend phase: it takes a LoanBrokerID
// (to originate) and/or a LoanID (to view/repay an existing loan), plus the
// signing keys described in the plan. Reads only the LoanBroker and Loan ledger
// entries and the vault referenced by the broker.
//
// Two-party signing: a browser-extension wallet adapter can produce a normal
// single-party signature (the borrower's TxnSignature) but has no notion of
// XLS-66's CounterpartySignature — only xrpl.js's signLoanSetByCounterparty,
// operating on a local Wallet, can add it. So the borrower step offers a choice
// (connected wallet OR a locally-held seed), while the counterparty step always
// takes a seed. Seeds live only in local state and are cleared immediately after
// producing a signature; they are never logged or sent anywhere but the local
// sign call.

import { useCallback, useEffect, useState } from "react";
import { Wallet, signLoanSetByCounterparty, LoanPayFlags } from "xrpl";
import { Header } from "../../components/Header";
import { NetworkBanner, StatCard, AmountInput, TxButton, CodeBadge } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { readBroker, readLoan, readVault } from "../../lib/lending-read";
import {
  formatDrops,
  groupThousands,
  roundUpToAssetUnit,
  formatRippleTime,
  shortId,
} from "../../lib/format";
import { getClient, explorerUrl } from "../../lib/xrpl-client";
import { isDemoEnabled, seedScenario } from "../../lib/scenario";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { CheckCircle2, XCircle, ExternalLink, Info } from "lucide-react";

const POLL_MS = 6000;

function brokerIdFromUrl() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("broker") || "";
}
function loanIdFromUrl() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("loan") || "";
}

/** LedgerIndex of the first created Loan in a LoanSet's tx metadata. */
function findCreatedLoanId(meta) {
  for (const node of meta?.AffectedNodes || []) {
    const created = node.CreatedNode;
    if (created && created.LedgerEntryType === "Loan") return created.LedgerIndex;
  }
  return null;
}

/** Submit an already-signed blob and wait for a validated result. */
async function submitBlob(blob) {
  const client = await getClient();
  const res = await client.submitAndWait(blob);
  return { code: res.result.meta?.TransactionResult, hash: res.result.hash, meta: res.result.meta };
}

/** Result + explorer-link display, mirroring TxButton for a raw-blob submit. */
function OutcomeAlert({ outcome }) {
  if (!outcome) return null;
  if (outcome.error) {
    return (
      <Alert variant="destructive">
        <XCircle className="h-4 w-4" />
        <AlertTitle>Not submitted</AlertTitle>
        <AlertDescription className="break-all">{outcome.error}</AlertDescription>
      </Alert>
    );
  }
  const success = outcome.code === "tesSUCCESS";
  return (
    <Alert variant={success ? "success" : "destructive"}>
      {success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      <AlertTitle className="flex items-center gap-2">
        <CodeBadge code={outcome.code} />
      </AlertTitle>
      <AlertDescription>
        {outcome.hash && (
          <a
            href={explorerUrl(outcome.hash)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs underline"
          >
            View on explorer <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </AlertDescription>
    </Alert>
  );
}

export default function LoanPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  // ---- broker (for Counterparty/Owner + VaultID) ----
  const [brokerIdInput, setBrokerIdInput] = useState(() => brokerIdFromUrl());
  const [brokerId, setBrokerId] = useState(() => brokerIdFromUrl());
  const [broker, setBroker] = useState(null);
  const [brokerLoadError, setBrokerLoadError] = useState(null);

  // ---- loan (viewed/repaid; also the origination's output) ----
  const [loanIdInput, setLoanIdInput] = useState(() => loanIdFromUrl());
  const [loanId, setLoanId] = useState(() => loanIdFromUrl());
  const [loan, setLoan] = useState(null);
  const [loanLoadError, setLoanLoadError] = useState(null);

  const [demoStatus, setDemoStatus] = useState(() =>
    !brokerIdFromUrl() && !loanIdFromUrl() && isDemoEnabled() ? "seeding" : null,
  );

  // ---- origination terms ----
  const [principal, setPrincipal] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [paymentInterval, setPaymentInterval] = useState("");
  const [paymentTotal, setPaymentTotal] = useState("");
  const [gracePeriod, setGracePeriod] = useState("");
  const [originationFee, setOriginationFee] = useState("");

  // ---- two-signature wizard ----
  const [borrowerMode, setBorrowerMode] = useState("wallet"); // "wallet" | "seed"
  const [borrowerSeed, setBorrowerSeed] = useState("");
  const [borrowerAddress, setBorrowerAddress] = useState(null);
  const [borrowerBlob, setBorrowerBlob] = useState(null);
  const [borrowerSignError, setBorrowerSignError] = useState(null);

  const [counterpartySeed, setCounterpartySeed] = useState("");
  const [fullBlob, setFullBlob] = useState(null);
  const [coSignError, setCoSignError] = useState(null);

  const [assetsTotalBefore, setAssetsTotalBefore] = useState(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitOutcome, setSubmitOutcome] = useState(null);
  const [receipt, setReceipt] = useState(null); // { principalDrops, feeDrops, assetsTotalAfter }

  // ---- repay ----
  const [repayMode, setRepayMode] = useState("ontime"); // "ontime" | "late" | "full"
  // null = "no manual edit yet, show the suggested default for the current mode"
  const [repayAmount, setRepayAmount] = useState(null);
  const [isOverdue, setIsOverdue] = useState(false);

  // Seed a throwaway demo scenario behind `?demo` (dev-only; never a source
  // another phase reads). `?broker=`/`?loan=` are applied via lazy initializers.
  useEffect(() => {
    if (brokerIdFromUrl() || loanIdFromUrl() || !isDemoEnabled()) return;
    seedScenario()
      .then(({ brokerId: seededBrokerId, loanId: seededLoanId }) => {
        setBrokerIdInput(seededBrokerId);
        setBrokerId(seededBrokerId);
        setLoanIdInput(seededLoanId);
        setLoanId(seededLoanId);
        setDemoStatus("done");
      })
      .catch((err) => setDemoStatus(`error: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  const refreshBroker = useCallback(async () => {
    if (!brokerId) return;
    try {
      const b = await readBroker(brokerId);
      setBroker(b);
      setBrokerLoadError(null);
    } catch (err) {
      setBrokerLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [brokerId]);

  useEffect(() => {
    if (!brokerId) return;
    let cancelled = false;
    function poll() {
      readBroker(brokerId)
        .then((b) => {
          if (!cancelled) {
            setBroker(b);
            setBrokerLoadError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setBrokerLoadError(err instanceof Error ? err.message : String(err));
        });
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [brokerId]);

  // Ripple-epoch "now", captured only where a loan read lands (never called
  // directly during render, which the impure-function rule forbids).
  const applyLoanRead = useCallback((l) => {
    setLoan(l);
    setLoanLoadError(null);
    const rippleNow = Math.floor(Date.now() / 1000) - 946684800;
    setIsOverdue(rippleNow > Number(l.NextPaymentDueDate ?? 0));
  }, []);

  const refreshLoan = useCallback(async () => {
    if (!loanId) return;
    try {
      const l = await readLoan(loanId);
      applyLoanRead(l);
    } catch (err) {
      setLoanLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [loanId, applyLoanRead]);

  useEffect(() => {
    if (!loanId) return;
    let cancelled = false;
    function poll() {
      readLoan(loanId)
        .then((l) => {
          if (!cancelled) applyLoanRead(l);
        })
        .catch((err) => {
          if (!cancelled) setLoanLoadError(err instanceof Error ? err.message : String(err));
        });
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loanId, applyLoanRead]);

  const handleLoadBroker = (e) => {
    e.preventDefault();
    setBrokerId(brokerIdInput.trim());
    setBorrowerBlob(null);
    setFullBlob(null);
    setSubmitOutcome(null);
  };

  const handleLoadLoan = (e) => {
    e.preventDefault();
    setLoanId(loanIdInput.trim());
  };

  // ---- step 1: borrower signs the autofilled LoanSet ----
  const handleBorrowerSign = async () => {
    setBorrowerSignError(null);
    if (!broker) return;
    try {
      const account =
        borrowerMode === "wallet" ? address : Wallet.fromSeed(borrowerSeed).classicAddress;
      if (!account) throw new Error("No borrower account available to sign with.");
      setBorrowerAddress(account);

      const client = await getClient();
      const fields = {
        TransactionType: "LoanSet",
        Account: account,
        Counterparty: broker.Owner,
        LoanBrokerID: brokerId,
        PrincipalRequested: principal,
      };
      if (interestRate) fields.InterestRate = Number(interestRate);
      if (paymentInterval) fields.PaymentInterval = Number(paymentInterval);
      if (paymentTotal) fields.PaymentTotal = Number(paymentTotal);
      if (gracePeriod) fields.GracePeriod = Number(gracePeriod);
      if (originationFee) fields.LoanOriginationFee = originationFee;
      const tx = await client.autofill(fields);

      let blob;
      if (borrowerMode === "wallet") {
        if (!walletManager?.account) throw new Error("Connect a wallet first.");
        const signed = await walletManager.sign(tx);
        blob = signed.tx_blob;
      } else {
        blob = Wallet.fromSeed(borrowerSeed).sign(tx).tx_blob;
      }
      setBorrowerSeed(""); // never held longer than the signing call needs it
      setBorrowerBlob(blob);
      setFullBlob(null);
      setSubmitOutcome(null);

      // Cash-basis check: AssetsTotal must not move at origination.
      try {
        const vault = await readVault(broker.VaultID);
        setAssetsTotalBefore(vault.AssetsTotal ?? "0");
      } catch {
        setAssetsTotalBefore(null);
      }
    } catch (err) {
      setBorrowerSeed("");
      setBorrowerSignError(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- step 2: counterparty (broker owner) co-signs ----
  const handleCoSign = () => {
    setCoSignError(null);
    try {
      const wallet = Wallet.fromSeed(counterpartySeed);
      const { tx_blob } = signLoanSetByCounterparty(wallet, borrowerBlob);
      setFullBlob(tx_blob);
    } catch (err) {
      setCoSignError(err instanceof Error ? err.message : String(err));
    } finally {
      setCounterpartySeed(""); // never held longer than the co-sign call needs it
    }
  };

  // ---- step 3: submit whichever blob is on hand (full, or borrower-only to
  // demonstrate the missing-counterparty-signature rejection) ----
  const handleSubmit = async (blob) => {
    setSubmitBusy(true);
    setSubmitOutcome(null);
    try {
      const outcome = await submitBlob(blob);
      setSubmitOutcome(outcome);
      if (outcome.code === "tesSUCCESS") {
        const newLoanId = findCreatedLoanId(outcome.meta);
        if (newLoanId) {
          setLoanId(newLoanId);
          setLoanIdInput(newLoanId);
        }
        const feeDrops = originationFee || "0";
        setReceipt({ principalDrops: principal, feeDrops });
        if (broker) {
          readVault(broker.VaultID)
            .then((v) => setReceipt((r) => ({ ...r, assetsTotalAfter: v.AssetsTotal ?? "0" })))
            .catch(() => {});
        }
        refreshBroker();
      }
    } catch (err) {
      setSubmitOutcome({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitBusy(false);
    }
  };

  // ---- repay ----
  const periodicPayment = loan ? roundUpToAssetUnit(loan.PeriodicPayment ?? "0") : "0";
  const fullPayment = loan ? roundUpToAssetUnit(loan.TotalValueOutstanding ?? "0") : "0";
  const paymentRemaining = loan ? Number(loan.PaymentRemaining ?? 0) : 0;
  // `repayAmount` is null until the user edits it or switches mode; until then
  // the input shows this mode's suggested default (pure render-time derivation,
  // no effect needed to keep it in sync).
  const suggestedRepayAmount = repayMode === "full" ? fullPayment : periodicPayment;
  const effectiveRepayAmount = repayAmount ?? suggestedRepayAmount;

  const selectRepayMode = (mode) => {
    setRepayMode(mode);
    setRepayAmount(null);
  };

  const repayFlags =
    repayMode === "late"
      ? LoanPayFlags.tfLoanLatePayment
      : repayMode === "full"
        ? LoanPayFlags.tfLoanFullPayment
        : undefined;

  const isOwnerBorrower = loan && address ? loan.Borrower === address : null;

  const onRepayResult = useCallback(() => {
    refreshLoan();
  }, [refreshLoan]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1">
        <div className="container max-w-4xl py-6 space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Loan Desk</h1>
            <p className="text-muted-foreground text-sm">
              Originate a loan with the two-party <code>LoanSet</code> and run repayments.
            </p>
          </div>

          <NetworkBanner />

          {demoStatus === "seeding" && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>Seeding demo scenario</AlertTitle>
              <AlertDescription>
                Funding accounts and building a vault + broker + loan on the devnet. This can take
                up to a minute.
              </AlertDescription>
            </Alert>
          )}
          {typeof demoStatus === "string" && demoStatus.startsWith("error:") && (
            <Alert variant="destructive">
              <AlertTitle>Demo seed failed</AlertTitle>
              <AlertDescription>{demoStatus.slice("error: ".length)}</AlertDescription>
            </Alert>
          )}

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Originate</h2>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Loan broker</CardTitle>
                <CardDescription>The broker to originate against; its owner is the counterparty.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <form className="flex gap-2" onSubmit={handleLoadBroker}>
                  <Input
                    value={brokerIdInput}
                    onChange={(e) => setBrokerIdInput(e.target.value.trim())}
                    placeholder="Loan broker ledger index (64 hex chars)"
                    className="font-mono text-xs"
                  />
                  <Button type="submit" variant="secondary">
                    Load
                  </Button>
                </form>
                {broker && (
                  <p className="text-xs text-muted-foreground break-all">
                    Counterparty (owner): <span className="font-mono">{shortId(broker.Owner, 10)}</span>
                  </p>
                )}
                {brokerLoadError && (
                  <Alert variant="destructive">
                    <AlertTitle>Could not read broker</AlertTitle>
                    <AlertDescription className="break-all">{brokerLoadError}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {broker && (
              <Card className="mt-3">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Terms</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <AmountInput
                    id="principal"
                    label="Principal requested (drops)"
                    value={principal}
                    onChange={setPrincipal}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="interest-rate">Interest rate (1/10 bps, 50000 = 50%)</Label>
                      <Input
                        id="interest-rate"
                        inputMode="numeric"
                        value={interestRate}
                        onChange={(e) => setInterestRate(e.target.value.trim())}
                        placeholder="e.g. 50000"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="payment-interval">Payment interval (seconds, min 60)</Label>
                      <Input
                        id="payment-interval"
                        inputMode="numeric"
                        value={paymentInterval}
                        onChange={(e) => setPaymentInterval(e.target.value.trim())}
                        placeholder="e.g. 2592000"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="payment-total">Number of payments</Label>
                      <Input
                        id="payment-total"
                        inputMode="numeric"
                        value={paymentTotal}
                        onChange={(e) => setPaymentTotal(e.target.value.trim())}
                        placeholder="e.g. 12"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="grace-period">Grace period (seconds)</Label>
                      <Input
                        id="grace-period"
                        inputMode="numeric"
                        value={gracePeriod}
                        onChange={(e) => setGracePeriod(e.target.value.trim())}
                        placeholder="e.g. 300"
                      />
                    </div>
                  </div>
                  <AmountInput
                    id="origination-fee"
                    label="Origination fee (drops, optional — paid to the broker owner)"
                    value={originationFee}
                    onChange={setOriginationFee}
                  />
                </CardContent>
              </Card>
            )}

            {broker && principal && (
              <Card className="mt-3">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Step 1 &middot; Borrower signs</CardTitle>
                  <CardDescription>
                    Produces a partial blob (missing the counterparty signature) to hand off.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Button
                      variant={borrowerMode === "wallet" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setBorrowerMode("wallet")}
                    >
                      Use connected wallet
                    </Button>
                    <Button
                      variant={borrowerMode === "seed" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setBorrowerMode("seed")}
                    >
                      Paste borrower seed (demo)
                    </Button>
                  </div>
                  {borrowerMode === "wallet" && !isConnected && (
                    <p className="text-xs text-destructive">Connect a wallet first.</p>
                  )}
                  {borrowerMode === "seed" && (
                    <Input
                      type="password"
                      autoComplete="off"
                      value={borrowerSeed}
                      onChange={(e) => setBorrowerSeed(e.target.value)}
                      placeholder="Borrower seed (never sent anywhere; cleared after signing)"
                      className="font-mono text-xs"
                    />
                  )}
                  <Button
                    onClick={handleBorrowerSign}
                    disabled={borrowerMode === "wallet" ? !isConnected : !borrowerSeed}
                  >
                    Sign as borrower
                  </Button>
                  {borrowerSignError && (
                    <Alert variant="destructive">
                      <AlertTitle>Sign failed</AlertTitle>
                      <AlertDescription className="break-all">{borrowerSignError}</AlertDescription>
                    </Alert>
                  )}
                  {borrowerBlob && (
                    <div className="space-y-1.5">
                      <Label>Borrower-signed blob (share with the counterparty)</Label>
                      <textarea
                        readOnly
                        value={borrowerBlob}
                        rows={3}
                        className="w-full rounded-md border bg-muted/30 p-2 font-mono text-xs break-all"
                        onClick={(e) => e.target.select()}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigator.clipboard?.writeText(borrowerBlob)}
                        >
                          Copy
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={submitBusy}
                          onClick={() => handleSubmit(borrowerBlob)}
                        >
                          Submit now (negative control — missing counterparty signature)
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {borrowerBlob && (
              <Card className="mt-3">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Step 2 &middot; Counterparty co-signs</CardTitle>
                  <CardDescription>
                    The broker owner adds <code>CounterpartySignature</code>. Always a local seed &mdash;
                    no wallet adapter supports this custom co-sign.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Borrower-signed blob (paste here for a real two-party handoff)</Label>
                    <textarea
                      value={borrowerBlob}
                      onChange={(e) => setBorrowerBlob(e.target.value)}
                      rows={3}
                      className="w-full rounded-md border p-2 font-mono text-xs break-all"
                    />
                  </div>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={counterpartySeed}
                    onChange={(e) => setCounterpartySeed(e.target.value)}
                    placeholder="Counterparty (broker owner) seed — never sent anywhere; cleared after signing"
                    className="font-mono text-xs"
                  />
                  <Button onClick={handleCoSign} disabled={!counterpartySeed}>
                    Co-sign as counterparty
                  </Button>
                  {coSignError && (
                    <Alert variant="destructive">
                      <AlertTitle>Co-sign failed</AlertTitle>
                      <AlertDescription className="break-all">{coSignError}</AlertDescription>
                    </Alert>
                  )}
                  {fullBlob && (
                    <div className="space-y-1.5">
                      <Label>Fully-signed blob</Label>
                      <textarea
                        readOnly
                        value={fullBlob}
                        rows={3}
                        className="w-full rounded-md border bg-muted/30 p-2 font-mono text-xs break-all"
                        onClick={(e) => e.target.select()}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {fullBlob && (
              <Card className="mt-3">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Step 3 &middot; Submit</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Button disabled={submitBusy} onClick={() => handleSubmit(fullBlob)}>
                    {submitBusy ? "Submitting…" : "Submit LoanSet"}
                  </Button>
                  <OutcomeAlert outcome={submitOutcome} />
                  {submitOutcome?.code === "tesSUCCESS" && receipt && (
                    <Alert>
                      <Info className="h-4 w-4" />
                      <AlertTitle>Origination receipt</AlertTitle>
                      <AlertDescription className="space-y-1">
                        <p>
                          Borrower received{" "}
                          <span className="font-mono">
                            {groupThousands(
                              formatDrops(
                                (BigInt(receipt.principalDrops) - BigInt(receipt.feeDrops || "0")).toString(),
                              ),
                            )}{" "}
                            XRP
                          </span>{" "}
                          (principal minus origination fee).
                        </p>
                        <p>
                          Vault AssetsTotal before:{" "}
                          <span className="font-mono">
                            {assetsTotalBefore ? groupThousands(formatDrops(assetsTotalBefore)) : "—"} XRP
                          </span>{" "}
                          &middot; after:{" "}
                          <span className="font-mono">
                            {receipt.assetsTotalAfter ? groupThousands(formatDrops(receipt.assetsTotalAfter)) : "—"}{" "}
                            XRP
                          </span>{" "}
                          &mdash; unchanged: interest is cash-basis, booked on <code>LoanPay</code>, not here.
                        </p>
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Loan</h2>
            <Card>
              <CardContent className="pt-6 space-y-3">
                <form className="flex gap-2" onSubmit={handleLoadLoan}>
                  <Input
                    value={loanIdInput}
                    onChange={(e) => setLoanIdInput(e.target.value.trim())}
                    placeholder="Loan ledger index (64 hex chars), or originate one above"
                    className="font-mono text-xs"
                  />
                  <Button type="submit" variant="secondary">
                    Load
                  </Button>
                </form>
                {loanLoadError && (
                  <Alert variant="destructive">
                    <AlertTitle>Could not read loan</AlertTitle>
                    <AlertDescription className="break-all">{loanLoadError}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {loan && (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <StatCard
                    label="Principal outstanding"
                    value={`${groupThousands(formatDrops(loan.PrincipalOutstanding ?? "0"))} XRP`}
                  />
                  <StatCard
                    label="Total value outstanding"
                    value={`${groupThousands(formatDrops(loan.TotalValueOutstanding ?? "0"))} XRP`}
                    sub="principal + fees + interest"
                  />
                  <StatCard label="Payments remaining" value={String(loan.PaymentRemaining ?? 0)} />
                  <StatCard
                    label="Next payment due"
                    value={formatRippleTime(loan.NextPaymentDueDate) ?? "—"}
                    sub={isOverdue ? "overdue" : undefined}
                  />
                  <StatCard
                    label="Periodic payment"
                    value={`${groupThousands(formatDrops(loan.PeriodicPayment ?? "0"))} XRP`}
                    sub={`rounded up to pay: ${groupThousands(periodicPayment)} drops`}
                  />
                </div>

                {isConnected && isOwnerBorrower === false && (
                  <Alert variant="warning" className="mt-3">
                    <AlertTitle>Connected wallet is not this loan&apos;s borrower</AlertTitle>
                    <AlertDescription>
                      Only <span className="font-mono">{shortId(loan.Borrower, 10)}</span> may pay this
                      loan. You can still try &mdash; the ledger will reject it.
                    </AlertDescription>
                  </Alert>
                )}

                <Card className="mt-3">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Repay</CardTitle>
                    <CardDescription>Pick a mode, then adjust the amount to demonstrate a guardrail if you want.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant={repayMode === "ontime" ? "default" : "outline"}
                        onClick={() => selectRepayMode("ontime")}
                      >
                        On-time
                      </Button>
                      <Button
                        size="sm"
                        variant={repayMode === "late" ? "default" : "outline"}
                        onClick={() => selectRepayMode("late")}
                      >
                        Late (tfLoanLatePayment)
                      </Button>
                      {paymentRemaining > 1 && (
                        <Button
                          size="sm"
                          variant={repayMode === "full" ? "default" : "outline"}
                          onClick={() => selectRepayMode("full")}
                        >
                          Full early settlement (tfLoanFullPayment)
                        </Button>
                      )}
                    </div>
                    {isOverdue && repayMode === "ontime" && (
                      <p className="text-xs text-amber-700">
                        This loan is past its due date. Paying without the late flag will likely be
                        rejected with <code>tecEXPIRED</code> &mdash; switch to &quot;Late&quot; or try it anyway
                        to see the guardrail.
                      </p>
                    )}
                    <AmountInput
                      id="repay-amount"
                      label="Amount (drops)"
                      value={effectiveRepayAmount}
                      onChange={setRepayAmount}
                    />
                    <TxButton
                      label="Submit LoanPay"
                      disabled={
                        !isConnected || !loan || !/^\d+$/.test(effectiveRepayAmount) || effectiveRepayAmount === "0"
                      }
                      tx={() => {
                        const tx = {
                          TransactionType: "LoanPay",
                          Account: address,
                          LoanID: loanId,
                          Amount: effectiveRepayAmount,
                        };
                        if (repayFlags) tx.Flags = repayFlags;
                        return tx;
                      }}
                      onResult={onRepayResult}
                    />
                  </CardContent>
                </Card>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
