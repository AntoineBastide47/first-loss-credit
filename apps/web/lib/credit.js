// Credit policy: what a borrower may draw, and at what rate.
//
// Everything here is a pure function of values already read from the ledger, so the
// browser (showing a quote) and the server (deciding whether to co-sign) compute the
// same numbers from the same inputs. No network, no storage, no state.
//
// Rates use the ledger's InterestRate scale: 100000 = 100% APR, which is also the
// protocol's maximum. Amounts are BigInt base units of the market's asset.

import { baseUnits, roundUpToAssetUnit } from "./format";

export const RATE_MAX = 100000;

const big = (v) => baseUnits(v);
/** High-precision loan/broker figures (XRPLNumber) as whole base units, rounded up. */
const units = (v) => BigInt(roundUpToAssetUnit(v));

// ---- loan flags (xrpl LoanFlags) ----
export const LSF_LOAN_DEFAULT = 0x00010000;
export const LSF_LOAN_IMPAIRED = 0x00020000;

/**
 * True when a loan is fully repaid. A settled Loan object stays on the ledger with its
 * balances omitted (XRPL drops zero values), while fixed term fields like PeriodicPayment
 * remain. Reading those leftovers as an amount due makes a closed loan look overdue.
 * A defaulted loan also has zero balances, so check the default flag before this.
 */
export const isSettled = (loan) =>
  !!loan && !Number(loan.PaymentRemaining ?? 0) && !Number(loan.PrincipalOutstanding ?? 0);

// ---- the utilisation curve ----

// A kinked curve: cheap while the pool has slack, steep once it is nearly all lent.
// Above the kink the rate climbs fast, which pays borrowers to repay and lenders to
// deposit exactly when there is no liquidity left to withdraw. Utilisation is in basis
// points (10000 = 100%); the rates are on the ledger's 1e5 scale.
export const CURVE = { base: 2000, slope1: 8000, kink: 8000, slope2: 60000 };

// Price in whole-percent utilisation bands. A quote then survives the small drift
// between the moment it is shown and the moment the desk re-derives it to co-sign.
const BAND_BPS = 100;

/** Fraction of vault assets currently lent out, in basis points (0..10000). */
export function utilisationBps(vault) {
  const total = big(vault?.AssetsTotal);
  if (total <= 0n) return 0;
  const lent = total - big(vault?.AssetsAvailable);
  if (lent <= 0n) return 0;
  const bps = Number((lent * 10000n) / total);
  return bps > 10000 ? 10000 : bps;
}

/** The market's borrow rate at this utilisation, before any borrower spread. */
export function baseRate(utilBps) {
  const { base, slope1, kink, slope2 } = CURVE;
  const u = Math.min(10000, Math.floor(utilBps / BAND_BPS) * BAND_BPS);
  return u <= kink
    ? base + Math.floor((slope1 * u) / kink)
    : base + slope1 + Math.floor((slope2 * (u - kink)) / (10000 - kink));
}

// ---- borrower tiers ----

// A tier sets the spread over the market rate and the unsecured limit, the latter as a
// share of the pool (basis points of AssetsTotal). The ladder is earned on-ledger: only
// repaid loans move a borrower up, and a default or an overdue loan stops them lending.
export const TIERS = {
  blocked: { label: "On hold", spread: 0, limitBps: 0 },
  new: { label: "New borrower", spread: 4000, limitBps: 500 },
  established: { label: "Established", spread: 2000, limitBps: 1500 },
  trusted: { label: "Trusted", spread: 500, limitBps: 3000 },
};

// Holding the market's own credential is the only identity signal that is worth real
// money, because someone did work to issue it. It cuts the spread and raises the limit.
export const VERIFIED = { spread: -1000, limitBps: 2000 };

// Collateral locked to the desk lends against itself, at a haircut.
export const COLLATERAL_LTV_BPS = 8000;

/**
 * A borrower's record, read from the Loan objects in their owner directory. History
 * (repayments, defaults) counts across every market; exposure counts only this one,
 * because the limit is a share of this pool.
 *
 * Note the record lives in Loan objects, so a market whose desk deletes a defaulted loan
 * loses that default. Only the desk can delete a loan, never the borrower.
 */
export function creditProfile(loans, brokerId, nowRipple) {
  const p = { repaid: 0, defaults: 0, impaired: 0, overdue: 0, active: 0, activeHere: 0, exposure: 0n };
  for (const { loan } of loans) {
    const flags = Number(loan?.Flags ?? 0);
    if (flags & LSF_LOAN_DEFAULT) {
      p.defaults += 1;
      continue;
    }
    if (isSettled(loan)) {
      p.repaid += 1;
      continue;
    }
    p.active += 1;
    if (flags & LSF_LOAN_IMPAIRED) p.impaired += 1;
    if (nowRipple > Number(loan.NextPaymentDueDate ?? 0) + Number(loan.GracePeriod ?? 0)) p.overdue += 1;
    if (loan.LoanBrokerID === brokerId) {
      p.activeHere += 1;
      p.exposure += units(loan.PrincipalOutstanding);
    }
  }
  p.tier =
    p.defaults > 0 || p.overdue > 0 || p.impaired > 0
      ? "blocked"
      : p.repaid >= 3
        ? "trusted"
        : p.repaid >= 1
          ? "established"
          : "new";
  return p;
}

// ---- repayment terms ----

// The borrower chooses how long to repay over and how many payments to make in that time;
// the interval falls out of the two. The ledger requires PaymentInterval >= 60s and
// GracePeriod between 60s and the interval, so combinations it cannot express are never
// offered rather than offered and rejected.
const DAY = 86400;
export const TERMS = [
  { id: "1d", label: "1 day", seconds: DAY },
  { id: "7d", label: "1 week", seconds: 7 * DAY },
  { id: "30d", label: "30 days", seconds: 30 * DAY },
  { id: "3mo", label: "3 months", seconds: 90 * DAY },
  { id: "6mo", label: "6 months", seconds: 180 * DAY },
  { id: "1y", label: "1 year", seconds: 365 * DAY },
  { id: "2y", label: "2 years", seconds: 2 * 365 * DAY },
  { id: "3y", label: "3 years", seconds: 3 * 365 * DAY },
  { id: "5y", label: "5 years", seconds: 5 * 365 * DAY },
];
export const PAYMENT_COUNTS = [1, 3, 6, 12, 24, 60];

const MIN_PAYMENT_INTERVAL = 60;
const GRACE_DIVISOR = 6;
const WEEK = 7 * 86400;

// Longer means riskier: more time for the borrower's situation to change. The premium is
// concave, because most of that increase happens early: the step from a day to a week is a
// real change in exposure, the step from three years to five is not. A premium linear in
// time would pass the protocol's 100% rate cap before two years and price every long loan
// at the same wall.
//
//   1 week +0.40%   30 days +0.96%   1 year +2.29%   5 years +3.21%
export const TERM_PREMIUM_PER_DOUBLING = 400;
// Paying more often makes the pool whole sooner, which is worth a little back.
export const FREQUENCY_DISCOUNT_PER_PAYMENT = 100;
const FREQUENCY_DISCOUNT_MAX = 600;

export const termPremium = (seconds) =>
  Math.round(TERM_PREMIUM_PER_DOUBLING * Math.log2(1 + seconds / WEEK));
const frequencyDiscount = (payments) =>
  Math.min(FREQUENCY_DISCOUNT_MAX, (payments - 1) * FREQUENCY_DISCOUNT_PER_PAYMENT);

/** The LoanSet schedule for a term and payment count, or null when the ledger forbids it. */
export function scheduleFor(termSeconds, payments) {
  const PaymentInterval = Math.floor(termSeconds / payments);
  if (PaymentInterval < MIN_PAYMENT_INTERVAL) return null;
  const GracePeriod = Math.max(MIN_PAYMENT_INTERVAL, Math.min(PaymentInterval, Math.floor(PaymentInterval / GRACE_DIVISOR)));
  return { PaymentInterval, PaymentTotal: payments, GracePeriod };
}

/** Every repayment schedule the desk offers. A pure cross product, no ledger reads. */
export function offeredSchedules() {
  const out = [];
  for (const t of TERMS) {
    for (const payments of PAYMENT_COUNTS) {
      const schedule = scheduleFor(t.seconds, payments);
      if (schedule) out.push({ termId: t.id, termLabel: t.label, termSeconds: t.seconds, payments, schedule });
    }
  }
  return out;
}

/**
 * The offered schedule a signed loan is asking for, or null when it is asking for one the
 * desk does not offer. (PaymentInterval, PaymentTotal) determines the term, so at most one
 * option can match.
 */
export function matchSchedule(options, tx) {
  return (
    options.find(
      (o) =>
        o.schedule.PaymentInterval === Number(tx.PaymentInterval) &&
        o.schedule.PaymentTotal === Number(tx.PaymentTotal) &&
        o.schedule.GracePeriod === Number(tx.GracePeriod),
    ) || null
  );
}

/** The rate this borrower pays in this market, for this schedule, on the 1e5 scale. */
export function loanRate({ utilBps, profile, verified, termSeconds, payments }) {
  const spread = TIERS[profile.tier].spread + (verified ? VERIFIED.spread : 0);
  const rate = baseRate(utilBps) + spread + termPremium(termSeconds) - frequencyDiscount(payments);
  return Math.max(CURVE.base, Math.min(RATE_MAX, rate));
}

const headroom = (cap, used) => (cap > used ? cap - used : 0n);

/**
 * Every limit that binds a new loan in this market. A null cap means the limit does not
 * apply. The last three are protocol rules: exceeding any of them makes the ledger reject
 * the LoanSet, so checking them here turns a raw tec code into a sentence.
 */
// Long loans freeze lender capital, so the pool limits how much of itself may be tied up in
// them AT ONCE. This is a property of the whole book, not of any one loan: sizing each loan
// down separately does not stop many borrowers freezing the pool between them, it only
// makes borrowing useless. Concentration in any single borrower is the credit limit's job.
export const DURATION_BUDGET = { thresholdSeconds: 30 * DAY, shareBps: 5000 };

/**
 * Principal the broker already has out in loans with a long way still to run. Remaining
 * term is PaymentInterval * PaymentRemaining, so a loan drops out of the budget as it
 * amortises rather than tying capital up for its original term.
 */
export function longDatedExposure(loans, thresholdSeconds = DURATION_BUDGET.thresholdSeconds) {
  let total = 0n;
  for (const { loan } of loans) {
    if (!loan || Number(loan.Flags ?? 0) & LSF_LOAN_DEFAULT || isSettled(loan)) continue;
    const remaining = Number(loan.PaymentInterval ?? 0) * Number(loan.PaymentRemaining ?? 0);
    if (remaining > thresholdSeconds) total += units(loan.PrincipalOutstanding);
  }
  return total;
}

/** What is left of the pool's long-dated budget, or null when this loan is not long. */
function durationHeadroom(vault, longExposure, termSeconds) {
  if (termSeconds <= DURATION_BUDGET.thresholdSeconds) return null;
  const budget = (big(vault.AssetsTotal) * BigInt(DURATION_BUDGET.shareBps)) / 10000n;
  return headroom(budget, longExposure);
}

export function principalCaps({ vault, broker, profile, termSeconds, longExposure = 0n, collateralBase = 0n, verified = false }) {
  const limitBps = BigInt(TIERS[profile.tier].limitBps + (verified ? VERIFIED.limitBps : 0));
  const credit =
    (big(vault.AssetsTotal) * limitBps) / 10000n + (collateralBase * BigInt(COLLATERAL_LTV_BPS)) / 10000n;
  const debtMax = units(broker.DebtMaximum);
  const debt = units(broker.DebtTotal);
  const coverMin = big(broker.CoverRateMinimum);
  return [
    { label: "your credit limit", cap: headroom(credit, profile.exposure) },
    { label: "the pool's available liquidity", cap: big(vault.AssetsAvailable) },
    { label: "how much of this pool is already lent long", cap: durationHeadroom(vault, longExposure, termSeconds) },
    { label: "this market's debt cap", cap: debtMax > 0n ? headroom(debtMax, debt) : null },
    // A loan is refused unless cover still covers CoverRateMinimum of total debt.
    { label: "the first-loss cover behind this market", cap: coverMin > 0n ? headroom((units(broker.CoverAvailable) * 100000n) / coverMin, debt) : null },
  ];
}

/** The smallest cap and what it is, from principalCaps(). */
export function bindingLimit(caps) {
  let best = null;
  for (const c of caps) {
    if (c.cap == null) continue;
    if (!best || c.cap < best.cap) best = c;
  }
  return best ?? { label: "your credit limit", cap: 0n };
}
