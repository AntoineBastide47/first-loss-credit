"use client";

import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { formatDrops, groupThousands } from "../../lib/format";

// Controlled input for a base-unit amount (drops). `value`/`onChange` carry the raw
// base-unit string; the helper line shows the formatted XRP value so the operator
// sees both. Money stays a string end to end (never a JS number).
export function AmountInput({
  id,
  label = "Amount (drops)",
  value,
  onChange,
  placeholder = "e.g. 20000000",
  unit = "XRP",
  disabled,
}) {
  const isInteger = /^\d+$/.test(value || "");
  return (
    <div className="space-y-1.5">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Input
        id={id}
        inputMode="numeric"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim())}
      />
      {value ? (
        isInteger ? (
          <p className="text-xs text-muted-foreground">
            = {groupThousands(formatDrops(value))} {unit}
          </p>
        ) : (
          <p className="text-xs text-destructive">Enter a whole number of base units</p>
        )
      ) : null}
    </div>
  );
}
