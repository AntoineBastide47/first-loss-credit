"use client";

// Phase 6.1 — Vault Lender Console. A senior lender's screen: deposit XRP into a
// vault, watch share value and yield rise with no new deposit, and redeem shares
// above par. Independent of every other UI/backend phase: it takes a VaultID (paste
// or `?vault=`) and the connected wallet, and reads only `vault_info` + the wallet's
// share MPT balance.

import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "../../components/Header";
import { NetworkBanner, StatCard, AmountInput, TxButton } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { readVault, shareBalance, sharePrice, redeemableAssets } from "../../lib/lending-read";
import { formatDrops, groupThousands, ratioString, shortId } from "../../lib/format";
import { isDemoEnabled, seedScenario } from "../../lib/scenario";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Info } from "lucide-react";

const POLL_MS = 6000;

// Cost basis is a client-side convenience the lender's browser keeps, not ledger
// state (XLS-65 stores no cost basis). Keyed by vault + address so it does not leak
// across positions.
function basisKey(vaultId, address) {
  return `flc:lender-basis:${vaultId}:${address}`;
}

function loadBasis(vaultId, address) {
  if (typeof window === "undefined") return 0n;
  try {
    return BigInt(window.localStorage.getItem(basisKey(vaultId, address)) || "0");
  } catch {
    return 0n;
  }
}

function saveBasis(vaultId, address, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(basisKey(vaultId, address), value.toString());
  } catch {
    // Best-effort only; losing this never affects funds, only the displayed gain.
  }
}

/** `?vault=` from the page URL (client-side only), for a linkable console. */
function vaultIdFromUrl() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("vault") || "";
}

/** Pure read, no React state: the vault plus the lender's share balance. */
async function fetchVaultAndShares(vaultId, address) {
  const vault = await readVault(vaultId);
  const shares = address && vault.ShareMPTID ? await shareBalance(address, vault.ShareMPTID) : "0";
  return { vault, shares };
}

export default function LenderPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [vaultIdInput, setVaultIdInput] = useState(() => vaultIdFromUrl());
  const [vaultId, setVaultId] = useState(() => vaultIdFromUrl());
  const [vault, setVault] = useState(null);
  const [shares, setShares] = useState("0");
  const [loadError, setLoadError] = useState(null);
  const [demoStatus, setDemoStatus] = useState(() =>
    !vaultIdFromUrl() && isDemoEnabled() ? "seeding" : null,
  );

  const [depositAmount, setDepositAmount] = useState("");
  const [redeemShares, setRedeemShares] = useState("");
  const [withdrawAssets, setWithdrawAssets] = useState("");

  const depositAmountRef = useRef("");
  const redeemStartSharesRef = useRef("0");

  // Cost basis is a derived read of localStorage, not React state: it needs no
  // effect to stay in sync, and every render (e.g. after a write refreshes the
  // vault) picks up whatever refresh/write handlers last saved.
  const basis = vaultId && address ? loadBasis(vaultId, address) : 0n;

  // Seed a throwaway demo scenario behind `?demo` so the screen has something to
  // show (dev-only; never a source another phase reads). A `?vault=` id is applied
  // synchronously via the lazy initializers above, so this only runs for the demo.
  useEffect(() => {
    if (vaultIdFromUrl() || !isDemoEnabled()) return;
    seedScenario()
      .then(({ vaultId: seededId }) => {
        setVaultIdInput(seededId);
        setVaultId(seededId);
        setDemoStatus("done");
      })
      .catch((err) => setDemoStatus(`error: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  // Read-after-write for the deposit/redeem handlers: fetch, update state, and
  // return the fresh values so a handler need not wait on React state timing.
  const refresh = useCallback(async () => {
    if (!vaultId) return null;
    try {
      const result = await fetchVaultAndShares(vaultId, address);
      setVault(result.vault);
      setShares(result.shares);
      setLoadError(null);
      return result;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [vaultId, address]);

  // Poll on a timer. `poll` is a plain function local to this effect (not a
  // useCallback) so every setState here happens inside a Promise callback,
  // never synchronously in the effect body.
  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    function poll() {
      fetchVaultAndShares(vaultId, address)
        .then((result) => {
          if (cancelled) return;
          setVault(result.vault);
          setShares(result.shares);
          setLoadError(null);
        })
        .catch((err) => {
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
        });
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [vaultId, address]);

  const handleLoad = (e) => {
    e.preventDefault();
    setVaultId(vaultIdInput.trim());
  };

  const onDepositResult = useCallback(
    ({ code }) => {
      if (code === "tesSUCCESS" && vaultId && address && /^\d+$/.test(depositAmountRef.current)) {
        const next = loadBasis(vaultId, address) + BigInt(depositAmountRef.current);
        saveBasis(vaultId, address, next);
        setDepositAmount("");
      }
      refresh();
    },
    [vaultId, address, refresh],
  );

  // Shared by both redeem modes: the shares balance drops either way, so the same
  // before/after diff drives the proportional cost-basis reduction.
  const onRedeemResult = useCallback(
    async ({ code }) => {
      const result = await refresh();
      if (code === "tesSUCCESS" && vaultId && address && result) {
        const before = BigInt(redeemStartSharesRef.current || "0");
        const after = BigInt(result.shares || "0");
        const redeemed = before - after;
        if (after === 0n) {
          saveBasis(vaultId, address, 0n);
        } else if (redeemed > 0n && before > 0n) {
          const currentBasis = loadBasis(vaultId, address);
          const next = currentBasis - (currentBasis * redeemed) / before;
          saveBasis(vaultId, address, next);
        }
        setRedeemShares("");
        setWithdrawAssets("");
      }
    },
    [vaultId, address, refresh],
  );

  const sharesBig = BigInt(shares || "0");
  const price = vault ? sharePrice(vault) : null;
  const redeemableDrops = vault ? redeemableAssets(vault, sharesBig) : 0n;
  const gain = redeemableDrops - basis;
  const lossUnrealized = vault ? BigInt(vault.LossUnrealized ?? "0") : 0n;
  const assetsAvailable = vault ? BigInt(vault.AssetsAvailable ?? "0") : 0n;
  const assetsTotal = vault ? BigInt(vault.AssetsTotal ?? "0") : 0n;
  const outstandingShares = vault?.shares?.OutstandingAmount ?? "0";
  const utilPct =
    vault && assetsTotal > 0n ? ratioString((assetsTotal - assetsAvailable) * 100n, assetsTotal, 2) : null;

  const redeemSharesValid = /^\d+$/.test(redeemShares) && redeemShares !== "";
  const redeemSharesBig = redeemSharesValid ? BigInt(redeemShares) : 0n;
  const redeemImpliedAssets = vault && redeemSharesValid ? redeemableAssets(vault, redeemSharesBig) : 0n;
  const redeemExceedsBalance = redeemSharesValid && redeemSharesBig > sharesBig;
  const redeemBlockedByLiquidity = redeemSharesValid && redeemImpliedAssets > assetsAvailable;
  const redeemDisabled =
    !isConnected ||
    !vault ||
    !redeemSharesValid ||
    redeemSharesBig === 0n ||
    redeemExceedsBalance ||
    redeemBlockedByLiquidity;

  const withdrawValid = /^\d+$/.test(withdrawAssets) && withdrawAssets !== "";
  const withdrawBig = withdrawValid ? BigInt(withdrawAssets) : 0n;
  const withdrawBlockedByLiquidity = withdrawValid && withdrawBig > assetsAvailable;
  const withdrawDisabled = !isConnected || !vault || !withdrawValid || withdrawBig === 0n || withdrawBlockedByLiquidity;

  const depositValid = /^\d+$/.test(depositAmount) && depositAmount !== "" && depositAmount !== "0";
  const depositDisabled = !isConnected || !vault || !depositValid;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1">
        <div className="container max-w-4xl py-6 space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Vault Lender Console</h1>
            <p className="text-muted-foreground text-sm">
              Deposit XRP into a vault and watch share value rise from real loan yield &mdash;
              nothing here is a stored field, everything is derived from a fresh{" "}
              <code>vault_info</code> read.
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

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Vault</CardTitle>
              <CardDescription>Paste a Vault ID, or open this page with `?vault=&lt;id&gt;`.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex gap-2" onSubmit={handleLoad}>
                <Input
                  value={vaultIdInput}
                  onChange={(e) => setVaultIdInput(e.target.value.trim())}
                  placeholder="Vault ledger index (64 hex chars)"
                  className="font-mono text-xs"
                />
                <Button type="submit" variant="secondary">
                  Load
                </Button>
              </form>
              {vault && (
                <p className="mt-2 text-xs text-muted-foreground break-all">
                  Share MPT: <span className="font-mono">{shortId(vault.ShareMPTID, 10)}</span>
                </p>
              )}
              {loadError && (
                <Alert variant="destructive" className="mt-3">
                  <AlertTitle>Could not read vault</AlertTitle>
                  <AlertDescription className="break-all">{loadError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {vault && (
            <>
              <section>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">Your position</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  <StatCard label="Your shares" value={groupThousands(shares)} sub="share MPT base units" />
                  <StatCard
                    label="Redeemable value"
                    value={`${groupThousands(formatDrops(redeemableDrops.toString()))} XRP`}
                    sub={lossUnrealized !== 0n ? "reduced by an unrealized loss below" : "shares × (derived rate)"}
                  />
                  <StatCard
                    label="Gain vs. deposited"
                    value={`${gain < 0n ? "-" : "+"}${groupThousands(formatDrops((gain < 0n ? -gain : gain).toString()))} XRP`}
                    sub={`cost basis (deposited, net): ${groupThousands(formatDrops(basis.toString()))} XRP`}
                  />
                </div>
                {!isConnected && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Connect a wallet to see your own shares and cost basis.
                  </p>
                )}
              </section>

              <section>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">Vault state</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCard label="Assets total" value={`${groupThousands(formatDrops(vault.AssetsTotal))} XRP`} />
                  <StatCard
                    label="Assets available"
                    value={`${groupThousands(formatDrops(vault.AssetsAvailable ?? "0"))} XRP`}
                    sub="free to withdraw now"
                  />
                  <StatCard label="Outstanding shares" value={groupThousands(outstandingShares)} />
                  <StatCard
                    label="Share price (derived)"
                    value={price ?? "—"}
                    sub="AssetsTotal ÷ shares, not a stored field"
                  />
                  <StatCard label="Utilisation" value={utilPct ? `${utilPct}%` : "—"} sub="1 − available/total" />
                  {lossUnrealized !== 0n && (
                    <StatCard
                      label="Unrealized loss"
                      value={`${groupThousands(formatDrops(lossUnrealized.toString()))} XRP`}
                      sub="lowers redemption value (see 6.4)"
                      className="border-amber-300"
                    />
                  )}
                </div>
              </section>

              <section className="grid gap-6 md:grid-cols-2">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Deposit</CardTitle>
                    <CardDescription>Mints shares at the current deposit rate.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <AmountInput
                      id="deposit-amount"
                      label="Deposit amount (drops)"
                      value={depositAmount}
                      onChange={setDepositAmount}
                    />
                    <TxButton
                      label="Deposit"
                      disabled={depositDisabled}
                      tx={() => {
                        depositAmountRef.current = depositAmount;
                        return {
                          TransactionType: "VaultDeposit",
                          Account: address,
                          VaultID: vaultId,
                          Amount: depositAmount,
                        };
                      }}
                      onResult={onDepositResult}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Redeem</CardTitle>
                    <CardDescription>Share amount redeems full value; asset amount leaves yield behind.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Tabs defaultValue="shares">
                      <TabsList>
                        <TabsTrigger value="shares">Shares (full value)</TabsTrigger>
                        <TabsTrigger value="assets">XRP (leaves yield)</TabsTrigger>
                      </TabsList>

                      <TabsContent value="shares" className="space-y-3">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label htmlFor="redeem-shares">Shares to redeem</Label>
                            <button
                              type="button"
                              className="text-xs underline text-muted-foreground"
                              onClick={() => setRedeemShares(shares)}
                            >
                              Redeem all ({groupThousands(shares)})
                            </button>
                          </div>
                          <Input
                            id="redeem-shares"
                            inputMode="numeric"
                            value={redeemShares}
                            onChange={(e) => setRedeemShares(e.target.value.trim())}
                            placeholder="e.g. 20000000"
                          />
                          {redeemSharesValid && (
                            <p className="text-xs text-muted-foreground">
                              = {groupThousands(formatDrops(redeemImpliedAssets.toString()))} XRP at the current
                              redeem rate
                            </p>
                          )}
                          {redeemExceedsBalance && (
                            <p className="text-xs text-destructive">
                              You hold only {groupThousands(shares)} shares.
                            </p>
                          )}
                          {redeemBlockedByLiquidity && (
                            <p className="text-xs text-destructive">
                              Vault liquidity is insufficient right now (AssetsAvailable is below the value this
                              would pay out &mdash; a liquidity limit, not a balance limit). Try a smaller amount
                              or wait for repayments.
                            </p>
                          )}
                        </div>
                        <TxButton
                          label="Redeem shares"
                          disabled={redeemDisabled}
                          tx={() => {
                            redeemStartSharesRef.current = shares;
                            return {
                              TransactionType: "VaultWithdraw",
                              Account: address,
                              VaultID: vaultId,
                              Amount: { mpt_issuance_id: vault.ShareMPTID, value: redeemShares },
                            };
                          }}
                          onResult={onRedeemResult}
                        />
                      </TabsContent>

                      <TabsContent value="assets" className="space-y-3">
                        <AmountInput
                          id="withdraw-assets"
                          label="Withdraw amount (drops)"
                          value={withdrawAssets}
                          onChange={setWithdrawAssets}
                        />
                        <p className="text-xs text-muted-foreground">
                          Pays out exactly this asset amount and burns only the shares needed &mdash; any share
                          value above what you request stays deposited. Use the share-amount tab to take the
                          full redemption value.
                        </p>
                        {withdrawBlockedByLiquidity && (
                          <p className="text-xs text-destructive">
                            Vault liquidity is insufficient right now (AssetsAvailable is below this amount &mdash;
                            a liquidity limit, not a balance limit). Try a smaller amount or wait for repayments.
                          </p>
                        )}
                        <TxButton
                          label="Withdraw XRP"
                          variant="outline"
                          disabled={withdrawDisabled}
                          tx={() => {
                            redeemStartSharesRef.current = shares;
                            return {
                              TransactionType: "VaultWithdraw",
                              Account: address,
                              VaultID: vaultId,
                              Amount: withdrawAssets,
                            };
                          }}
                          onResult={onRedeemResult}
                        />
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
