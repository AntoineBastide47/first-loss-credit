"use client";

import { useState } from "react";
import { useWallet } from "../providers/WalletProvider";
import { getClient, explorerUrl } from "../../lib/xrpl-client";
import { Button } from "../ui/button";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CheckCircle2, XCircle, ExternalLink } from "lucide-react";

// Shared write button for every screen. It signs `tx` through the connected
// wallet, waits for a validated ledger, then shows the engine result code, an
// explorer link, and a plain-language cause (every write shows its result, incl.
// tec rejections). `explain` maps a result code to a plain cause; absent,
// only the raw code is shown, so this foundation is self-contained.
//
// `tx` is a transaction object or a () => object builder. `onResult({ code, hash,
// meta })` fires after a validated result for read-after-write refresh.

// Poll the shared read client for the validated result of a submitted tx. Bounded.
async function waitForValidatedResult(hash) {
  const client = await getClient();
  for (let guard = 0; guard < 40; guard += 1) {
    try {
      const { result } = await client.request({ command: "tx", transaction: hash });
      if (result.validated) return result.meta?.TransactionResult;
    } catch {
      // txnNotFound until the tx is in a validated ledger; keep polling.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${hash} to validate`);
}

export function TxButton({
  tx,
  label = "Submit",
  variant = "default",
  className,
  disabled,
  explain,
  context,
  onResult,
}) {
  const { walletManager, isConnected, showStatus } = useWallet();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // { code, hash } | { error }

  const handleClick = async () => {
    if (!walletManager?.account) {
      showStatus?.("Connect a wallet first", "error");
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const built = typeof tx === "function" ? tx() : tx;
      const transaction = built && typeof built.then === "function" ? await built : built;
      const submitted = await walletManager.signAndSubmit(transaction);
      const hash = submitted.hash || submitted.id;
      // tec rejections are applied (claimed fee) and validate with a tec code; only
      // tem/tef malformed/failed txs throw. Read the validated code either way.
      const code =
        submitted.meta?.TransactionResult || (hash ? await waitForValidatedResult(hash) : "unknown");
      setOutcome({ code, hash, txType: transaction.TransactionType });
      onResult?.({ code, hash, meta: submitted.meta });
    } catch (err) {
      setOutcome({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const success = outcome?.code === "tesSUCCESS";
  const rawInfo = outcome?.code && explain ? explain(outcome.txType, outcome.code, context) : null;
  const reason = typeof rawInfo === "string" ? rawInfo : rawInfo?.cause;

  return (
    <div className="space-y-2">
      <Button
        onClick={handleClick}
        disabled={disabled || busy || !isConnected}
        variant={variant}
        className={className}
      >
        {busy ? "Submitting…" : label}
      </Button>

      {outcome?.error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Not submitted</AlertTitle>
          <AlertDescription className="break-all">{outcome.error}</AlertDescription>
        </Alert>
      )}

      {outcome?.code && (
        <Alert variant={success ? "success" : "destructive"}>
          {success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          <AlertTitle>{success ? "Confirmed" : "Didn’t go through"}</AlertTitle>
          <AlertDescription className="space-y-1">
            {!success && <p>{reason || "Something went wrong. Please try again."}</p>}
            {outcome.hash && (
              <a
                href={explorerUrl(outcome.hash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs underline opacity-70"
              >
                Receipt <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
