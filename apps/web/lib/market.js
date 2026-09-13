// The lending markets this product operates on. Users never see or paste these ids;
// the app deposits into a vault and originates loans against its broker. Every market
// is owned by the same operator, so the server co-sign route needs no per-market seed.
//
// `asset` says how amounts are denominated (see lib/asset.js): an XRP vault or an
// MPT-denominated vault. Screens read the selected market's asset and adapt.

// Shared loan product terms. The borrow form autofills these and the server rejects any
// co-sign whose terms differ, so only PrincipalRequested (in the asset's base units)
// varies per loan.
export const LOAN_TERMS = { InterestRate: 100000, PaymentInterval: 3600, PaymentTotal: 6, GracePeriod: 600 };

const OPERATOR = "rNEBeRwhfnAP5JczQbT2mxnNAY1gYmPUVT";

// The desk account that co-signs loans server-side. Only markets it owns are borrowable
// through the app; markets a user launches (owned by their own wallet) support earning
// and cover but not the app's server co-sign.
export const DESK_OPERATOR = OPERATOR;

export const MARKETS = [
  {
    id: "xrp",
    name: "First-Loss Credit Vault",
    asset: { kind: "XRP" },
    vaultId: "85B73475255A53220913778E3E4F2CA2A977FD8128426BAA43C357F52FB9EF0F",
    shareMptId: "00000001983825300F9EAD15056FF4FBEDA3AE841A0515AF",
    brokerId: "23CB91C3A0286605328E7C9550DFB903D8B8A1B9087120DF371A776E2C8E1EE9",
    operator: OPERATOR,
    seedLoanId: "8638619C7EF6FBF2D6822703F1DE97E67EC539568F7F607590E6240B9ED4B159",
    loanTerms: LOAN_TERMS,
  },
  {
    id: "usdx",
    name: "USDX Credit Vault",
    asset: { kind: "MPT", issuanceId: "000128BAC26385F0319158AD1E86DBB1347EE10FB14AA533", scale: 2, symbol: "USDX" },
    vaultId: "B2E6C8DD579DF8B1D14565A2B833778F53E6FC6607E8BEA42EFA6681F4666600",
    shareMptId: "000000019B3B4D9E0047FDA0D76AF8892A4E0E4AF2D3A07F",
    brokerId: "0A58455DE661D6FBF62FCD86746196226CA369A77E69C91EC5119BB417F56774",
    operator: OPERATOR,
    seedLoanId: "2198C5919E16046C5E758E0B252F00028E4EB018938EB9C3490740FD9A4EE1B0",
    loanTerms: LOAN_TERMS,
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
