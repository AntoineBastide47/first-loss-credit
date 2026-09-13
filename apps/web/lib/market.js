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
    vaultId: "64229499E29AFE2B20B1CE6DFD701F25F626E06B0BB2AD5AA01B9A5C4D05DC97",
    shareMptId: "0000000181424C81D8D92F5C65460C777F5658C1B7CD8CD6",
    brokerId: "F8BAF813A7A60EBCF906C5F4C4F803337EA02AB913CE6708C887EF26E0A6F5FF",
    operator: OPERATOR,
  },
  {
    id: "usdx",
    name: "Meridian USDX Trade Finance",
    asset: { kind: "MPT", issuanceId: "000128BAC26385F0319158AD1E86DBB1347EE10FB14AA533", scale: 2, symbol: "USDX" },
    vaultId: "50BA978405F48113B83A35E9ED1CA9666990F8358433D794A1A073AFC9E22689",
    shareMptId: "00000001094FF5F25DF581B959C962762F073F061CB35189",
    brokerId: "A4EA657BBAAE79D68B84216231043D721F929258EA631E6D79A9F28AE866FCF2",
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
