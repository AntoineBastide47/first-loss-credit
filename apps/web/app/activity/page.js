"use client";

// Activity: what your account has actually done, read from its transaction history on the
// ledger. Current balances say where you are; this says how you got there, and it is the
// same on any device because none of it is stored in the browser.

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../../components/providers/WalletProvider";
import { allMarkets } from "../../lib/market";
import { discoverMarkets } from "../../lib/discover";
import { getClient, explorerUrl } from "../../lib/xrpl-client";
import { assetSymbol, formatAmount } from "../../lib/asset";
import { shortId } from "../../lib/format";
import { Card, CardContent } from "../../components/ui/card";
import { ExternalLink } from "lucide-react";

const RIPPLE_EPOCH = 946684800;

// What each lending transaction did, in plain words.
const LABELS = {
  VaultDeposit: "Deposited",
  VaultWithdraw: "Withdrew",
  VaultCreate: "Created a vault",
  VaultSet: "Changed vault settings",
  LoanSet: "Borrowed",
  LoanPay: "Repaid",
  LoanManage: "Managed a loan",
  LoanDelete: "Closed a loan record",
  LoanBrokerSet: "Created a broker",
  LoanBrokerCoverDeposit: "Added first-loss cover",
  LoanBrokerCoverWithdraw: "Withdrew first-loss cover",
  MPTokenIssuanceCreate: "Issued a token",
  MPTokenAuthorize: "Opted in to a token",
  CredentialCreate: "Issued a credential",
  CredentialAccept: "Accepted a credential",
  PermissionedDomainSet: "Set an access domain",
  EscrowCreate: "Locked collateral",
  EscrowFinish: "Released collateral",
  EscrowCancel: "Reclaimed collateral",
  Payment: "Payment",
};

const amountOf = (tx, meta) => meta?.delivered_amount ?? tx?.DeliverMax ?? tx?.Amount ?? null;

export default function ActivityPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [rows, setRows] = useState([]);
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let on = true;
    const local = allMarkets();
    setMarkets(local);
    discoverMarkets()
      .then((chain) => {
        if (!on) return;
        const seen = new Set(local.map((m) => m.vaultId));
        setMarkets([...local, ...chain.filter((m) => !seen.has(m.vaultId))]);
      })
      .catch(() => {});
    return () => { on = false; };
  }, []);

  const load = useCallback(async () => {
    if (!address) { setRows([]); return; }
    setLoading(true);
    try {
      const client = await getClient();
      const { result } = await client.request({
        command: "account_tx", account: address, limit: 100, ledger_index_min: -1, ledger_index_max: -1,
      });
      setRows(
        (result.transactions || [])
          .map((t) => ({ tx: t.tx_json || t.tx || {}, meta: t.meta, hash: t.hash || (t.tx_json || t.tx || {}).hash, date: (t.tx_json || t.tx || {}).date ?? t.close_time_iso }))
          .filter((r) => LABELS[r.tx.TransactionType]),
      );
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [address]);
  useEffect(() => { load(); }, [load]);

  // Match a transaction to a market so amounts can be shown in that market's asset.
  const marketFor = (tx) =>
    markets.find((m) => m.vaultId === tx.VaultID || m.brokerId === tx.LoanBrokerID) || markets[0] || null;

  const when = (r) => {
    const d = typeof r.date === "number" ? new Date((r.date + RIPPLE_EPOCH) * 1000) : r.date ? new Date(r.date) : null;
    return d ? d.toLocaleString() : "";
  };

  return (
    <div className="container max-w-3xl py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-muted-foreground">
          Everything this account has done across the markets, read from the ledger.
        </p>
      </div>

      {!isConnected && <p className="text-sm text-muted-foreground">Connect a wallet to see your activity.</p>}
      {isConnected && loading && rows.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
      {isConnected && !loading && rows.length === 0 && <p className="text-sm text-muted-foreground">No lending activity yet.</p>}

      {rows.length > 0 && (
        <Card>
          <CardContent className="divide-y divide-border/60 p-0">
            {rows.map((r, i) => {
              const m = marketFor(r.tx);
              const amt = amountOf(r.tx, r.meta);
              const asset = m?.asset;
              const failed = r.meta?.TransactionResult && r.meta.TransactionResult !== "tesSUCCESS";
              let shown = null;
              if (amt != null && asset) {
                if (typeof amt === "string" && asset.kind === "XRP") shown = `${formatAmount(asset, amt)} XRP`;
                else if (typeof amt === "object" && amt.value != null) shown = `${formatAmount(asset, String(amt.value).split(".")[0])} ${assetSymbol(asset)}`;
              }
              return (
                <div key={r.hash || i} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
                  <div>
                    <p className="font-medium">
                      {LABELS[r.tx.TransactionType]}
                      {failed && <span className="ml-2 text-xs text-destructive">didn’t go through</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {when(r)}
                      {m && (r.tx.VaultID || r.tx.LoanBrokerID) ? ` · ${m.name}` : ""}
                      {r.tx.Destination ? ` · to ${shortId(r.tx.Destination, 6)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {shown && <span className="font-medium tabular-nums">{shown}</span>}
                    {r.hash && (
                      <a href={explorerUrl(r.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline opacity-70">
                        Receipt <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
