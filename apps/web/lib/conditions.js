"use client";

// PREIMAGE-SHA-256 crypto-condition for XLS-85 escrows, built in the browser with Web
// Crypto (no dependency). For a 32-byte preimage the DER encoding is fixed.

function toHexUpper(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function makeCondition() {
  const preimage = new Uint8Array(32);
  crypto.getRandomValues(preimage);
  const hashBuf = await crypto.subtle.digest("SHA-256", preimage);
  return {
    condition: `A0258020${toHexUpper(new Uint8Array(hashBuf))}810120`,
    fulfillment: `A0228020${toHexUpper(preimage)}`,
  };
}
