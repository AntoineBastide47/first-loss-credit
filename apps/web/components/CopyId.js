"use client";

// A vault id is how a market travels between people: discovery only crawls the desk's own
// account, so anything else is found by pasting its id into "Add by vault id" on /vaults.
// That makes the id worth copying in one click rather than selecting 64 hex characters.

import { useState } from "react";
import { shortId } from "../lib/format";
import { Check, Copy } from "lucide-react";

export function CopyId({ id, label = "id", chars = 6 }) {
  const [state, setState] = useState("idle"); // idle | copied | failed

  const copy = async () => {
    try {
      // Blocked in an insecure context or when the page is not focused, so never assume.
      await navigator.clipboard.writeText(id);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  };

  if (!id) return null;
  return (
    <button
      type="button"
      onClick={copy}
      title={id}
      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {label} {shortId(id, chars)}
      {state === "copied" ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {state === "copied" && <span className="font-sans not-italic text-emerald-600">copied</span>}
      {state === "failed" && <span className="font-sans text-destructive">press ⌘C</span>}
    </button>
  );
}
