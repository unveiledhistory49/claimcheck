/** Integer-cents money helpers. Parsing rejects excess precision — never rounds silently. */

export const MAX_MINOR = 10 ** 12; // $10B in cents; overflow guard

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Parse "1234.56" (or "1234") into integer cents. */
export function parseAmountToMinor(value: string): number {
  const raw = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new MoneyError(`invalid amount ${JSON.stringify(value)}: want dollars with ≤2 decimals`);
  }
  const [dollars, cents = "0"] = raw.split(".") as [string, string?];
  const minor = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new MoneyError(`invalid amount ${JSON.stringify(value)}: must be > 0`);
  }
  if (minor > MAX_MINOR) {
    throw new MoneyError(`amount ${JSON.stringify(value)} exceeds maximum ledger value`);
  }
  return minor;
}

export function formatMinor(minor: number): string {
  if (!Number.isInteger(minor)) throw new MoneyError("minor must be an integer");
  return `${(minor / 100).toFixed(2)} USD`;
}
