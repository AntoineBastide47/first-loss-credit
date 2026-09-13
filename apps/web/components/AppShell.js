"use client";

// Mounted once by the root layout. Layouts preserve state across client-side
// navigation, so the wallet manager is created a single time here and survives route
// changes. Creating it inside a page (or inside Header, which every page rendered)
// rebuilt the manager on every navigation and dropped the connection.

import { Header } from "./Header";
import { useWalletManager } from "../hooks/useWalletManager";

export function AppShell({ children }) {
  useWalletManager();
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">{children}</main>
    </div>
  );
}
