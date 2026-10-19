import { Prisma } from "@prisma/client";

/**
 * Money helpers. All money is `Prisma.Decimal` with 2 decimal places (BUSINESS_RULES §1).
 * Never use JavaScript numbers for amounts.
 */
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
export type DecimalInput = Prisma.Decimal.Value;

const ZERO = new Decimal(0);

export const toDecimal = (value: DecimalInput) => new Decimal(value);

/** Rounds to cents, half-up. */
export const roundMoney = (value: DecimalInput) =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const sumMoney = (values: Iterable<DecimalInput>) => {
  let total = ZERO;
  for (const v of values) total = total.plus(v);
  return total;
};

/**
 * Splits `total` across `weights` so the parts add up to `total` exactly (largest-remainder method,
 * BUSINESS_RULES §7). Each part is floored to cents, then the leftover cents go one at a time to the
 * parts with the largest remainders. Ties go to the earlier key, so callers should pass keys in a
 * stable order (e.g. sorted by member id).
 *
 * If every weight is zero, the total is split equally.
 */
export function splitByWeight<K>(
  total: DecimalInput,
  weights: ReadonlyArray<{ key: K; weight: DecimalInput }>,
) {
  if (weights.length === 0) return new Map<K, Decimal>();

  const amount = roundMoney(total);
  if (weights.some((w) => new Decimal(w.weight).isNegative())) {
    throw new RangeError("Weights must not be negative");
  }
  const totalWeight = sumMoney(weights.map((w) => w.weight));

  const effective = totalWeight.isZero()
    ? weights.map((w) => ({ key: w.key, weight: new Decimal(1) }))
    : weights.map((w) => ({ key: w.key, weight: new Decimal(w.weight) }));
  const weightSum = totalWeight.isZero() ? new Decimal(weights.length) : totalWeight;

  // Work in cents so every part is an integer number of cents.
  const totalCents = amount.times(100);
  const parts = effective.map(({ key, weight }, index) => {
    const exact = totalCents.times(weight).dividedBy(weightSum);
    const floored = exact.toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    return { key, index, cents: floored, remainder: exact.minus(floored) };
  });

  let leftover = totalCents.minus(sumMoney(parts.map((p) => p.cents))).toNumber();
  const byRemainder = [...parts].sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);
  for (const part of byRemainder) {
    if (leftover <= 0) break;
    part.cents = part.cents.plus(1);
    leftover -= 1;
  }

  return new Map(parts.map((p) => [p.key, p.cents.dividedBy(100)]));
}

/** Splits `total` equally between `keys`; the parts add up to `total` exactly. */
export const splitEqually = <K>(total: DecimalInput, keys: readonly K[]) =>
  splitByWeight(
    total,
    keys.map((key) => ({ key, weight: 1 })),
  );
