"use client";

// Single shared read client for the lending devnet. Every screen reads
// through getClient(); writes go through the connected wallet (see TxButton).
// The client is created once per browser tab and reused. xrpl.js reconnects on a
// dropped socket on its own; if connect() itself fails, the cached promise is
// cleared so the next call retries.

import { Client } from "xrpl";
import { DEFAULT_NETWORK } from "./networks";

// connect() asserts these are enabled; a screen shows a banner when any is missing.
const REQUIRED_AMENDMENTS = ["SingleAssetVault", "LendingProtocol"];

let clientPromise = null;

/** Connected, reused Client for DEFAULT_NETWORK. Bounded connect timeout. */
export async function getClient() {
  if (clientPromise) {
    const client = await clientPromise.catch(() => null);
    if (client && client.isConnected()) return client;
    clientPromise = null;
  }
  clientPromise = (async () => {
    const client = new Client(DEFAULT_NETWORK.wss, { connectionTimeout: 20000 });
    await client.connect();
    return client;
  })().catch((err) => {
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

/**
 * Names of the required amendments that are NOT enabled on the connected network.
 * An empty array means the network supports the lending flow.
 */
export async function missingAmendments() {
  const client = await getClient();
  const { result } = await client.request({ command: "feature" });
  const enabled = new Set(
    Object.values(result.features || {})
      .filter((f) => f.enabled)
      .map((f) => f.name),
  );
  return REQUIRED_AMENDMENTS.filter((a) => !enabled.has(a));
}

/** Explorer URL for a 64-hex tx hash or an account address. */
export function explorerUrl(hashOrAccount) {
  const kind = /^[0-9A-Fa-f]{64}$/.test(hashOrAccount) ? "transactions" : "accounts";
  return `${DEFAULT_NETWORK.explorer}/${kind}/${hashOrAccount}`;
}
