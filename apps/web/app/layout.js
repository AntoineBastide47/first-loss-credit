"use client";

import "./globals.css";
import { WalletProvider } from "../components/providers/WalletProvider";
import { AppShell } from "../components/AppShell";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-gray-50">
        <WalletProvider>
          <AppShell>{children}</AppShell>
        </WalletProvider>
      </body>
    </html>
  );
}
