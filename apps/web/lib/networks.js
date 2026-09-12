export const NETWORKS = {
  // Lending hackathon devnet: XLS-65/66 amendments enabled (verified 2026-09-12,
  // build 3.4.0-rc1, network 4001, reserves base 10 XRP / inc 2 XRP). The faucet
  // POSTs an empty body and returns a NEW funded account { address, secret }; it
  // ignores `destination`, so Client.fundWallet does not work here.
  LENDING_HACKATHON: {
    id: "lending-hackathon",
    name: "Lending Hackathon Devnet",
    networkId: 4001,
    wss: "wss://lending-hackathon.dev.ripplex.io:51233",
    faucet: "https://lending-hackathon-faucet.dev.ripplex.io/accounts",
    explorer: "https://custom.xrpl.org/lending-hackathon.dev.ripplex.io:51233",
    // WalletConnect CAIP-2 chain for signing. The custom devnet has no standard
    // chain id; the XRPL Dev Wallet's manual/custom network advertises "xrpl:0", and
    // WalletConnect v2 approves a session only for the wallet's own chain (it drops
    // requiredNamespaces), so the app must request that same id or request() rejects.
    walletConnectId: "xrpl:0",
  },
  ALPHANET: {
    id: "alphanet",
    name: "AlphaNet",
    networkId: 21465,
    wss: "wss://alphanet.nerdnest.xyz",
    faucet: "https://alphanet.faucet.nerdnest.xyz/accounts",
    explorer: "https://alphanet.xrpl.org",
  },
  TESTNET: {
    id: "testnet",
    name: "Testnet",
    networkId: 1,
    wss: "wss://s.altnet.rippletest.net:51233",
    faucet: "https://faucet.altnet.rippletest.net/accounts",
    explorer: "https://testnet.xrpl.org",
  },
  DEVNET: {
    id: "devnet",
    name: "Devnet",
    networkId: 2,
    wss: "wss://s.devnet.rippletest.net:51233",
    faucet: "https://faucet.devnet.rippletest.net/accounts",
    explorer: "https://devnet.xrpl.org",
  },
};

export const DEFAULT_NETWORK = NETWORKS.LENDING_HACKATHON;
