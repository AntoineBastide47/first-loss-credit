"use client";

// Loans: the desk's view of the loan book — outstanding loans, their health, and the
// ability to default an unrecoverable one (which draws down first-loss cover and, if
// short, realizes a loss to the vault). Human XRP; no ledger ids.

import { useCallback, useEffect, useState } from "react";
import { LoanManageFlags } from "xrpl";
import { Header } from "../../components/Header";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKET } from "../../lib/market";
import { marketBroker, knownLoans } from "../../lib/product";
import { readLoan } from "../../lib/lending-read";
import { formatDrops, groupThousands, roundUpToAssetUnit, formatRippleTime } from "../../lib/format";
import { Card, CardContent } from "../../components/ui/card";

const POLL_MS = 8000;
const xrp = (d) => groupThousands(formatDrops(String(d ?? "0")));
const big = (v) => BigInt(v ?? "0");
const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;
const LSF_LOAN_DEFAULT = 0x00010000;

function statusOf(loan) {
  const now = rippleNow();
  const due = Number(loan.NextPaymentDueDate ?? 0);
  const graceEnd = due + Number(loan.GracePeriod ?? 0);
  if ((Number(loan.Flags) & LSF_LOAN_DEFAULT) !== 0) return { label: "Defaulted", tone: "text-destructive" };
  if (now > graceEnd) return { label: "In default window", tone: "text-destructive", canDefault: true };
  if (now > due) return { label: "Overdue", tone: "text-amber-600" };
  return { label: "On track", tone: "text-emerald-600" };
}

export default function ManagePage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [broker, setBroker] = useState(null);
  const [loans, setLoans] = useState([]);

  const load = useCallback(async () => {
    try {
      setBroker(await marketBroker());
    } catch {
      /* ignore */
    }
    const ids = knownLoans();
    const read = await Promise.all(
      ids.map((id) => readLoan(id).then((l) => ({ id, loan: l })).catch(() => null)),
    );
    setLoans(read.filter(Boolean));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const isOperator = address === MARKET.operator;
  const cover = broker ? big(broker.CoverAvailable) : 0n;
  const debt = broker ? big(broker.DebtTotal) : 0n;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-3xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Loan book</h1>
            <p className="mt-1 text-muted-foreground">
              The loans this vault has made and their health. If a loan can’t be recovered, default
              it: first-loss cover absorbs the loss before lenders do.
            </p>
          </div>

          <Card>
            <CardContent className="grid grid-cols-2 gap-4 p-6">
              <div>
                <p className="text-xs text-muted-foreground">Total lent</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{xrp(debt)} XRP</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">First-loss cover</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600">{xrp(cover)} XRP</p>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            {loans.length === 0 && <p className="text-sm text-muted-foreground">No loans yet.</p>}
            {loans.map(({ id, loan }) => {
              const s = statusOf(loan);
              return (
                <Card key={id}>
                  <CardContent className="space-y-3 p-6">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-lg font-semibold tabular-nums">{xrp(loan.PrincipalOutstanding)} XRP outstanding</p>
                        <p className="text-xs text-muted-foreground">
                          {loan.PaymentRemaining ?? 0} payment(s) left · next due {formatRippleTime(loan.NextPaymentDueDate)}
                        </p>
                      </div>
                      <span className={`text-sm font-medium ${s.tone}`}>{s.label}</span>
                    </div>
                    {s.canDefault && isOperator && (
                      <TxButton
                        label="Default this loan"
                        variant="outline"
                        explain={explain}
                        disabled={!isConnected}
                        tx={() => ({ TransactionType: "LoanManage", Account: address, LoanID: id, Flags: LoanManageFlags.tfLoanDefault })}
                        onResult={load}
                      />
                    )}
                    {s.canDefault && !isOperator && (
                      <p className="text-xs text-muted-foreground">Only the desk can default this loan.</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <p className="text-center text-xs text-muted-foreground">Defaulting a loan is a desk action; the cover draw-down and any realized loss happen automatically.</p>
        </div>
      </main>
    </div>
  );
}
