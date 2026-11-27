export const GTIN_LENGTHS = [8, 12, 13, 14];

export const normalizeGtin = (value: string) => value.replace(/[\s-]/g, '');

// GS1 check digit: weights 3 and 1 alternate from the digit next to the check digit.
export function validCheckDigit(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(digits[i]) * weight;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

export type GtinProblem = 'format' | 'checksum' | 'restricted' | 'coupon';

export function checkGtin(value: string, lengths = GTIN_LENGTHS): GtinProblem | undefined {
  const digits = normalizeGtin(value);
  if (!/^\d+$/.test(digits) || !lengths.includes(digits.length)) return 'format';
  if (!validCheckDigit(digits)) return 'checksum';
  const as13 = digits.length === 14 ? digits.slice(1) : digits.padStart(13, '0');
  if (digits.length > 8 && /^(?:2|02|04)/.test(as13)) return 'restricted';
  if (digits.length > 8 && /^(?:05|98|99)/.test(as13)) return 'coupon';
  return undefined;
}
