"use client";

// Stop WalletConnect refusing to work because the browser guessed we are offline.
//
// xrpl-connect bundles WalletConnect, which gates every relay operation on one check:
//
//   async confirmOnlineStateOrThrow() {
//     if (!await isOnline()) throw new Error(
//       "No internet connection detected. Please restart your network and try again.");
//   }
//
// and in a browser `isOnline()` is nothing but `navigator.onLine`. No request is made, so
// the connection is never actually tested. That guard sits on 22 call sites (connect,
// pair, sign, disconnect, restartTransport and the reconnect heartbeat), so while the flag
// is false nothing can reach the relay, and the error blames the user's network.
//
// navigator.onLine is the browser's link-layer guess, not reachability. It goes false when
// the machine wakes from sleep, when a VPN connects or drops, and while a captive-portal
// check is pending, and it often stays false until something forces a re-evaluation. A
// page reload in that state (autoConnect restoring a session) hits the guard immediately.
//
// So stop asking the flag and let the attempt answer. The relay socket IS the reachability
// test, and it gives an accurate error: a genuinely offline browser now fails with
// "Couldn't establish socket connection to the relay server: wss://relay.walletconnect.org"
// instead of a false claim about the user's network. A real offline event still tears the
// transport down, and the reconnect heartbeat can then bring it back, which it cannot do
// while the flag is believed.
//
// This shadows the property for the whole page. Nothing else here reads navigator.onLine.

let installed = false;

/** Report the browser as online, so reachability is decided by connecting, not guessing. */
export function ignoreBrowserOnlineFlag() {
  if (installed || typeof navigator === "undefined") return;
  installed = true;
  try {
    // Navigator.onLine is an accessor on Navigator.prototype, so this defines an own
    // property on the instance that shadows it. A browser that refuses keeps its own flag.
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  } catch {
    /* not redefinable here; the guard stays as it was */
  }
}
