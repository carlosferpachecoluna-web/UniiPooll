export const SCORE_MIN = 1.0;
export const SCORE_MAX = 5.0;
export const SCORE_INITIAL = 4.5;

export const SCORE_ADJUSTMENTS = Object.freeze({
  on_time: 0.15,
  late: -0.4,
  default: -1.2
});

const toCents = value => Math.round(value * 100);

const CENTS_MIN = toCents(SCORE_MIN);
const CENTS_MAX = toCents(SCORE_MAX);
const CENTS_INITIAL = toCents(SCORE_INITIAL);

const CENTS_ADJUSTMENTS = new Map(
  Object.entries(SCORE_ADJUSTMENTS).map(([status, points]) => [status, toCents(points)])
);

const clampCents = cents => Math.min(CENTS_MAX, Math.max(CENTS_MIN, cents));

export function clampScore(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return SCORE_INITIAL;
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, value));
}

export function calculateStudentScore(paymentHistory = []) {
  const history = Array.isArray(paymentHistory) ? paymentHistory : [];
  let cents = CENTS_INITIAL;

  for (const payment of history) {
    const status = typeof payment === 'string' ? payment : payment?.status;
    const adjustment = CENTS_ADJUSTMENTS.get(status);
    if (adjustment === undefined) continue;
    cents = clampCents(cents + adjustment);
  }

  return clampScore(Math.round(cents / 10) / 10);
}

export function formatScore(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return clampScore(number).toFixed(1);
}
