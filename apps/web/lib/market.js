// The lending markets this product operates on. Users never see or paste these ids;
// the app deposits into a vault and originates loans against its broker. Every market
// is owned by the same operator, so the server co-sign route needs no per-market seed.
//
// `asset` says how amounts are denominated (see lib/asset.js): an XRP vault or an
// MPT-denominated vault. Screens read the selected market's asset and adapt.

// Loan terms are not configured here. The borrower picks a repayment schedule from the
// menu the desk offers, and the rate is priced per loan from the pool's utilisation, the
// borrower's record and the term they chose. See lib/credit.js.

const OPERATOR = "rNEBeRwhfnAP5JczQbT2mxnNAY1gYmPUVT";

// The desk account that co-signs loans server-side. Only markets it owns are borrowable
// through the app; markets a user launches (owned by their own wallet) support earning
// and cover but not the app's server co-sign.
export const DESK_OPERATOR = OPERATOR;

export const MARKETS = [
  {
    id: "xrp",
    name: "Meridian XRP Credit Fund",
    asset: { kind: "XRP" },
    vaultId: "FAF5997055899DA3F73FD9C69D1E2A2AB828F1415DA59E507C1E43F130F2A026",
    shareMptId: "00000001BDC84F5086CA2CABCA005C742C544B757B201A87",
    brokerId: "0449A1483403115DB18A1F3B5B09CC755677831B0D27D6C21ECF52042A5DE01A",
    operator: OPERATOR,
  },
  {
    id: "usdx",
    name: "Meridian USDX Trade Finance",
    asset: { kind: "MPT", issuanceId: "000128BAC26385F0319158AD1E86DBB1347EE10FB14AA533", scale: 2, symbol: "USDX" },
    vaultId: "AEB4A82431AB1C3A58A419E6E19FE48AF7111A27800E44A9B445B383E7B904F3",
    shareMptId: "00000001B836BF9381385199E624B0F54D32829ED207CA19",
    brokerId: "DA3954A430FC5E69ED171351415041E2527BA6069E6ACCDF1829B61ABBA4C5FC",
    operator: OPERATOR,
  },
];

// Markets a user launched, persisted per browser (the baked markets are read-only).
const CUSTOM_KEY = "flc:markets";
export function customMarkets() {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(CUSTOM_KEY) || "[]");
  } catch {
    return [];
  }
}
export function addMarket(market) {
  if (typeof window === "undefined") return;
  try {
    const list = customMarkets().filter((m) => m.id !== market.id);
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify([...list, market]));
  } catch {
    /* best effort */
  }
}
export function removeMarket(id) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(customMarkets().filter((m) => m.id !== id)));
  } catch {
    /* best effort */
  }
}

/** Baked markets plus any this browser has launched. */
export const allMarkets = () => [...MARKETS, ...customMarkets()];

/** Look up a market by id across baked and custom markets, defaulting to the first. */
export const getMarket = (id) => allMarkets().find((m) => m.id === id) || MARKETS[0];

// Default market for screens that operate on one market before a selection is made.
export const MARKET = MARKETS[0];
