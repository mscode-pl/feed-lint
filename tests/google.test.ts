import { createReadStream } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkGtin } from '../src/core/gtin.js';
import { lintFeed } from '../src/core/lint.js';

const lint = (name: string, ignore?: string[]) => lintFeed(createReadStream(new URL(`./fixtures/${name}`, import.meta.url)), { ignore });

describe('Google rules', () => {
  it('passes a clean feed', async () => {
    const result = await lint('google-good.xml');
    expect(result).toMatchObject({ format: 'google', records: 2, errors: 0, warnings: 0, results: [] });
  });

  it('reports every problem in the bad feed', async () => {
    const result = await lint('google-bad.xml');
    const byRule = Object.fromEntries(result.results.map((r) => [r.rule, r.samples.map((s) => `${s.line}:${s.id}`)]));
    expect(byRule).toEqual({
      'google/all-caps': ['6:A'],
      'google/availability-date': ['22:A'],
      'google/availability-value': ['10:A'],
      'google/brand-placeholder': ['13:A'],
      'google/color-value': ['14:A'],
      'google/condition-value': ['15:A'],
      'google/duplicate-id': ['18:A'],
      'google/gtin-checksum': ['12:A'],
      'google/gtin-format': ['27:A'],
      'google/gtin-restricted': ['26:A'],
      'google/html-in-text': ['7:A'],
      'google/http': ['9:A'],
      'google/identifier-exists-misused': ['39:B'],
      'google/image-format': ['9:A'],
      'google/image-url-ascii': ['9:A'],
      'google/missing-description': ['17:A'],
      'google/price-format': ['11:A'],
      'google/price-zero': ['37:B'],
      'google/promo-text': ['6:A'],
      'google/sale-date': ['25:A'],
      'google/sale-price': ['24:A'],
      'google/url-scheme': ['8:A'],
    });
    expect(result.results[0].level).toBe('error');
    expect(result.results.at(-1)?.level).toBe('warning');
  });

  it('explains why a price is wrong', async () => {
    const result = await lint('google-bad.xml');
    expect(result.results.find((r) => r.rule === 'google/price-format')?.samples[0].detail).toContain('dot as the decimal separator');
  });

  it('skips ignored rules', async () => {
    const result = await lint('google-bad.xml', ['google/duplicate-id', 'google/all-caps']);
    expect(result.results.map((r) => r.rule)).not.toContain('google/duplicate-id');
    expect(result.results.map((r) => r.rule)).not.toContain('google/all-caps');
  });

  it('reports an XML error as a rule', async () => {
    const result = await lint('broken.xml');
    expect(result.results[0]).toMatchObject({ rule: 'xml/parse', count: 1, samples: [{ line: 5 }] });
  });

  it('reports an unknown format', async () => {
    const result = await lint('unknown.xml');
    expect(result.results.map((r) => r.rule)).toEqual(['xml/format-unknown']);
  });
});

describe('checkGtin', () => {
  it.each([
    ['5901234123457', undefined],
    ['590-1234-123457', undefined],
    ['12345670', undefined],
    ['0001234567895', undefined],
    ['5901234123458', 'checksum'],
    ['12345', 'format'],
    ['59012341234AB', 'format'],
    ['2001234567893', 'restricted'],
    ['9812345678902', 'coupon'],
  ])('%s', (gtin, problem) => {
    expect(checkGtin(gtin)).toBe(problem);
  });
});
