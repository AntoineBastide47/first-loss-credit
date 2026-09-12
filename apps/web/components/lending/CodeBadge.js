"use client";

import { Badge } from "../ui/badge";

// Render an XRPL engine result code. tesSUCCESS is success; tec/tem/tef/tel codes
// are failures (destructive); anything else is neutral. The raw code is always
// shown (never hidden), per the Part 6 rule.
function variantFor(code) {
  if (code === "tesSUCCESS") return "success";
  if (/^te[cmfl]/.test(code || "")) return "destructive";
  return "secondary";
}

export function CodeBadge({ code, className }) {
  if (!code) return null;
  return (
    <Badge variant={variantFor(code)} className={className}>
      {code}
    </Badge>
  );
}
