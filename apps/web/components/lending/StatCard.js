"use client";

import { Card, CardContent } from "../ui/card";
import { cn } from "../../lib/utils";

// A labelled figure. `value` is pre-formatted (format money with lib/format; never
// pass a raw base-unit string). `sub` is an optional secondary line.
export function StatCard({ label, value, sub, className }) {
  return (
    <Card className={cn("", className)}>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 font-mono text-lg font-semibold tabular-nums break-all">
          {value ?? "—"}
        </p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground break-all">{sub}</p>}
      </CardContent>
    </Card>
  );
}
