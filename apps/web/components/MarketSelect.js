"use client";

// Market picker shared by the lender/borrow/desk screens. Lets a user choose which
// vault (XRP or an MPT-denominated one) to act on. Hidden when only one market exists.

import { MARKETS } from "../lib/market";
import { Label } from "./ui/label";

export function MarketSelect({ value, onChange, id = "market" }) {
  if (MARKETS.length < 2) return null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Market</Label>
      <select
        id={id}
        value={value.id}
        onChange={(e) => onChange(MARKETS.find((m) => m.id === e.target.value) || MARKETS[0])}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-72"
      >
        {MARKETS.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </div>
  );
}
