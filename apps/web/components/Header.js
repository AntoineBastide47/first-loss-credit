"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletConnector } from "./WalletConnector";
import { useWallet } from "./providers/WalletProvider";
import { cn } from "../lib/utils";

const NAV = [
  { href: "/earn", label: "Earn" },
  { href: "/borrow", label: "Borrow" },
  { href: "/vaults", label: "Vaults" },
  { href: "/activity", label: "Activity" },
];

export function Header() {
  const { statusMessage } = useWallet();
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="container flex h-16 items-center gap-3 sm:gap-6">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white">
            <span className="text-sm font-bold">◈</span>
          </div>
          <span className="hidden font-semibold tracking-tight sm:inline">First-Loss Credit</span>
        </Link>

        <nav className="flex items-center gap-0.5 sm:gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "rounded-full px-2.5 py-1.5 text-sm transition-colors sm:px-4",
                pathname === n.href
                  ? "bg-foreground text-background font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex flex-1 items-center justify-end gap-3">
          {statusMessage && statusMessage.type === "error" && (
            <span className="hidden text-xs text-destructive md:inline">{statusMessage.message}</span>
          )}
          <WalletConnector />
        </div>
      </div>
    </header>
  );
}
