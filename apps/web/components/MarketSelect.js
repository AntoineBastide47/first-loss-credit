"use client";

// Market picker shared by the lender/borrow/desk screens. Lets a user choose which
// vault (XRP or an MPT-denominated one, baked in or user-launched) to act on. Pass an
// explicit `markets` list to constrain the choice (borrow shows only desk markets).

import { useEffect, useState } from "react";
import { MARKETS, allMarkets } from "../lib/market";
import { Label } from "./ui/label";

export function MarketSelect({ value, onChange, markets, id = "market" }) {
  // Start from the baked markets (matches SSR), then add locally launched ones on mount.
  const [list, setList] = useState(markets || MARKETS);
  useEffect(() => {
    setList(markets || allMarkets());
  }, [markets]);

  // Always include the selected market, even if it is not yet in the list.
  const options = list.some((m) => m.id === value.id) ? list : [...list, value];
  if (options.length < 2) return null;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Market</Label>
      <select
        id={id}
        value={value.id}
        onChange={(e) => onChange(options.find((m) => m.id === e.target.value) || options[0])}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-72"
      >
        {options.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </div>
  );
}
