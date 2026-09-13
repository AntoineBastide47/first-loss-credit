"use client";

// Vaults hub: the market directory and the owner's control room. See total exposure,
// create a vault (with an inline-minted MPT asset and optional credential gating),
// manage the vaults you own (cover, broker terms, loan book, admissions), and browse
// the rest. This is where the vault lifecycle and its amendments live.

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../../components/providers/WalletProvider";
import { CreateVault } from "../../components/vaults/CreateVault";
import { VaultManager } from "../../components/vaults/VaultManager";
import { allMarkets, addMarket } from "../../lib/market";
import { discoverMarkets, lookupVault } from "../../lib/discover";
import { Input } from "../../components/ui/input";
import { CopyId } from "../../components/CopyId";
import { marketVault, marketBroker, utilisation } from "../../lib/product";
import { brokerLoans, isSettled } from "../../lib/lending-read";
import { assetSymbol, formatAmount } from "../../lib/asset";
import { Card, CardContent } from "../../components/ui/card";
import { Button } from "../../components/ui/button";

const POLL_MS = 10000;
const big = (v) => BigInt(v ?? "0");
const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;
const LSF_LOAN_DEFAULT = 0x00010000;

function statusOf(loan) {
  if (isSettled(loan)) return "Repaid";
  const now = rippleNow();
  const graceEnd = Number(loan.NextPaymentDueDate ?? 0) + Number(loan.GracePeriod ?? 0);
  if ((Number(loan.Flags) & LSF_LOAN_DEFAULT) !== 0) return "Defaulted";
  if (now > graceEnd) return "In default window";
  if (now > Number(loan.NextPaymentDueDate ?? 0)) return "Overdue";
  return "On track";
}

async function loadMarket(market) {
  const [vault, broker] = await Promise.all([marketVault(market).catch(() => null), marketBroker(market).catch(() => null)]);
  const loans = await brokerLoans(market.brokerId).catch(() => []);
  return { market, vault, broker, loans };
}

export default function VaultsPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [markets, setMarkets] = useState([]);
  const [rows, setRows] = useState([]);
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pasteId, setPasteId] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("name");

  // Local records first (they carry your names), then every market found on the ledger.
  const refreshMarkets = useCallback(async () => {
    const local = allMarkets();
    setMarkets(local);
    try {
      const chain = await discoverMarkets();
      const seen = new Set(local.map((m) => m.vaultId));
      setMarkets([...local, ...chain.filter((m) => !seen.has(m.vaultId))]);
    } catch {
      /* keep the local list */
    }
  }, []);
  useEffect(() => {
    refreshMarkets();
  }, [refreshMarkets, reloadKey]);

  const addById = useCallback(async () => {
    setAdding(true);
    setAddError(null);
    try {
      const m = await lookupVault(pasteId.trim().toUpperCase());
      addMarket(m);
      setPasteId("");
      setReloadKey((k) => k + 1);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }, [pasteId]);

  const load = useCallback(async () => {
    if (markets.length) setRows(await Promise.all(markets.map(loadMarket)));
  }, [markets]);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Markets you run: ones your wallet owns on-ledger, plus ones you created (the desk
  // holds those on your behalf so they can originate loans).
  const owned = markets.filter((m) => m.operator === address || m.creator === address);

  // Search and sort the directory on the settings each market actually carries.
  const decorated = markets.map((m) => {
    const row = rows.find((r) => r.market.id === m.id);
    return {
      m,
      row,
      asset: m.asset,
      sym: assetSymbol(m.asset),
      deposits: row?.vault ? big(row.vault.AssetsTotal) : 0n,
      cover: row?.broker ? big(row.broker.CoverAvailable) : 0n,
      util: row?.vault ? utilisation(row.vault) : 0,
      minCover: row?.broker ? Number(row.broker.CoverRateMinimum ?? 0) / 1000 : 0,
      mine: m.operator === address || m.creator === address,
    };
  });
  const q = query.trim().toLowerCase();
  const matched = q
    ? decorated.filter((d) =>
        [d.m.name, d.m.vaultId, d.sym, d.m.gate ? `gated ${d.m.gate.credentialType}` : "open"]
          .join(" ").toLowerCase().includes(q))
    : decorated;
  const cmpBig = (a, b) => (a === b ? 0 : a > b ? -1 : 1);
  const visibleMarkets = [...matched].sort((a, b) => {
    if (sortBy === "deposits") return cmpBig(a.deposits, b.deposits);
    if (sortBy === "cover") return cmpBig(a.cover, b.cover);
    if (sortBy === "utilisation") return b.util - a.util;
    if (sortBy === "minCover") return b.minCover - a.minCover;
    if (sortBy === "access") return Number(!!b.m.gate) - Number(!!a.m.gate) || a.m.name.localeCompare(b.m.name);
    return a.m.name.localeCompare(b.m.name);
  });

  const allLoans = rows.flatMap((r) => r.loans.filter((x) => !isSettled(x.loan)).map((x) => statusOf(x.loan)));
  const atRisk = allLoans.filter((s) => s !== "On track").length;
  const defaulted = allLoans.filter((s) => s === "Defaulted").length;

  const onCreated = useCallback((market) => {
    addMarket(market);
    setCreating(false);
    setReloadKey((k) => k + 1);
  }, []);

  return (
        <div className="container max-w-4xl py-8 space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Vaults</h1>
              <p className="mt-1 text-muted-foreground">Total exposure, the vaults you own, and every market on the desk.</p>
            </div>
            <Button onClick={() => setCreating((c) => !c)} disabled={!isConnected}>{creating ? "Close" : "Create a vault"}</Button>
          </div>
          {!isConnected && <p className="text-sm text-muted-foreground">Connect a wallet to create or manage vaults.</p>}

          <Card>
            <CardContent className="grid grid-cols-4 gap-4 p-6">
              <div><p className="text-xs text-muted-foreground">Markets</p><p className="mt-1 text-2xl font-semibold tabular-nums">{markets.length}</p></div>
              <div><p className="text-xs text-muted-foreground">Active loans</p><p className="mt-1 text-2xl font-semibold tabular-nums">{allLoans.length}</p></div>
              <div><p className="text-xs text-muted-foreground">At risk</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${atRisk ? "text-amber-600" : ""}`}>{atRisk}</p></div>
              <div><p className="text-xs text-muted-foreground">Defaulted</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${defaulted ? "text-destructive" : ""}`}>{defaulted}</p></div>
            </CardContent>
          </Card>

          {creating && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Create a vault</h2>
              <CreateVault address={address} isConnected={isConnected} onCreated={onCreated} />
            </div>
          )}

          {owned.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Your vaults</h2>
              {owned.map((m) => (
                <VaultManager key={m.id} market={m} address={address} isConnected={isConnected} onChanged={() => setReloadKey((k) => k + 1)} />
              ))}
            </div>
          )}

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">All markets</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Input value={pasteId} onChange={(e) => setPasteId(e.target.value.trim())} placeholder="Add by vault id" className="font-mono text-xs sm:w-72" />
                <Button variant="outline" size="sm" onClick={addById} disabled={!pasteId || adding}>{adding ? "Adding…" : "Add"}</Button>
              </div>
            </div>
            {addError && <p className="text-xs text-destructive break-all">{addError}</p>}

            <div className="flex flex-wrap items-center gap-2">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, id, asset, gated/open…" className="text-sm sm:max-w-xs" />
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <option value="name">Sort: name</option>
                <option value="deposits">Sort: deposits</option>
                <option value="cover">Sort: cover</option>
                <option value="utilisation">Sort: utilisation</option>
                <option value="minCover">Sort: minimum cover</option>
                <option value="access">Sort: access</option>
              </select>
              <span className="text-xs text-muted-foreground">{visibleMarkets.length} of {markets.length}</span>
            </div>

            {visibleMarkets.length === 0 && <p className="text-sm text-muted-foreground">No market matches that search.</p>}
            {visibleMarkets.map(({ m, row, asset, sym, deposits, cover, util, minCover, mine }) => {
              return (
                <Card key={m.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                    <div>
                      <p className="font-medium">
                        {m.name}
                        {mine && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">Yours</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {sym}
                        {m.gate ? ` · gated (${m.gate.credentialType})` : " · open"}
                        {row?.broker ? ` · min cover ${minCover.toFixed(1)}%` : ""}
                      </p>
                      {/* Share this id to open the market on another browser or wallet. */}
                      <CopyId id={m.vaultId} label="vault" />
                    </div>
                    <div className="flex gap-6 text-sm tabular-nums">
                      <div><p className="text-xs text-muted-foreground">Deposits</p><p className="font-medium">{formatAmount(asset, deposits)} {sym}</p></div>
                      <div><p className="text-xs text-muted-foreground">Cover</p><p className="font-medium text-emerald-600">{formatAmount(asset, cover)} {sym}</p></div>
                      <div><p className="text-xs text-muted-foreground">Utilisation</p><p className="font-medium">{(util * 100).toFixed(0)}%</p></div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
  );
}
