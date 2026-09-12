"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletConnector } from "./WalletConnector";
import { useWalletManager } from "../hooks/useWalletManager";
import { useWallet } from "./providers/WalletProvider";
import { cn } from "../lib/utils";

const NAV = [
  { href: "/earn", label: "Earn" },
  { href: "/cover", label: "Cover" },
  { href: "/borrow", label: "Borrow" },
  { href: "/manage", label: "Loans" },
  { href: "/access", label: "Access" },
  { href: "/tokens", label: "Tokens" },
  { href: "/escrow", label: "Escrow" },
  { href: "/collateral", label: "Collateral" },
];

export function Header() {
  useWalletManager();
  const { statusMessage } = useWallet();
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="container flex h-16 items-center gap-6">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white">
            <span className="text-sm font-bold">◈</span>
          </div>
          <span className="font-semibold tracking-tight">First-Loss Credit</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm transition-colors",
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
