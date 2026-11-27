import { createReadStream } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CENEO_RULES } from '../src/rules/ceneo.js';
import { lintFeed } from '../src/core/lint.js';

const lint = (name: string) => lintFeed(createReadStream(new URL(`./fixtures/${name}`, import.meta.url)));
const lintText = (xml: string) => lintFeed([xml]);
const rules = (result: Awaited<ReturnType<typeof lintFeed>>) => result.results.map((r) => r.rule).sort();

const offer = (attrs: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><offers version="1"><o id="1" url="https://x.pl/1" price="1.00" avail="1" ${attrs}>` +
  `<cat>A/B</cat><name>N</name><imgs><main url="https://x.pl/1.jpg"/></imgs><desc>D</desc><attrs><a name="Marka">M</a></attrs>${body}</o></offers>`;

describe('Ceneo rules', () => {
  it('passes a clean feed with GPSR, incremental update and ISBN', async () => {
    const result = await lint('ceneo-good.xml');
    expect(result).toMatchObject({ format: 'ceneo', records: 3, errors: 0, warnings: 0, results: [] });
  });

  it('reports every offer-level problem in the bad feed', async () => {
    const result = await lint('ceneo-bad.xml');
    expect(rules(result)).toEqual(
      [
        'ceneo/attr-duplicate',
        'ceneo/avail-value',
        'ceneo/basket',
        'ceneo/brand',
        'ceneo/cat-generic',
        'ceneo/ce-mark',
        'ceneo/ce-year',
        'ceneo/desc-cdata',
        'ceneo/desc-html',
        'ceneo/drug-code',
        'ceneo/duplicate-id',
        'ceneo/ean',
        'ceneo/energy-class',
        'ceneo/gpsr-reference',
        'ceneo/image-url',
        'ceneo/isbn',
        'ceneo/main-image',
        'ceneo/missing-attrs',
        'ceneo/missing-avail',
        'ceneo/missing-cat',
        'ceneo/missing-desc',
        'ceneo/missing-id',
        'ceneo/missing-imgs',
        'ceneo/missing-name',
        'ceneo/missing-price',
        'ceneo/missing-url',
        'ceneo/name-promo',
        'ceneo/price-format',
        'ceneo/price-zero',
        'ceneo/stock',
        'ceneo/url-scheme',
        'ceneo/weight',
      ].sort(),
    );
    const byRule = Object.fromEntries(result.results.map((r) => [r.rule, r.samples]));
    expect(byRule['ceneo/duplicate-id'][0]).toMatchObject({ line: 18, id: '1', detail: 'first used on line 3' });
    expect(byRule['ceneo/desc-html'][0].detail).toBe('<div>, <a>');
    expect(byRule['ceneo/ean'][0]).toMatchObject({ line: 9, detail: '"5901234123458"' });
  });

  it('checks the file header', async () => {
    expect(rules(await lint('ceneo-file.xml'))).toEqual(['ceneo/encoding', 'ceneo/file-version-length', 'ceneo/version']);
    expect(rules(await lint('ceneo-noenc.xml'))).toEqual(['ceneo/encoding-missing']);
  });

  it('decodes and accepts ISO-8859-2', async () => {
    const result = await lint('ceneo-iso.xml');
    expect(result.results.map((r) => r.rule)).not.toContain('ceneo/encoding');
  });

  it.each(['id-length', 'url-length', 'images-count'])('checks %s', async (rule) => {
    let xml = offer('', '');
    if (rule === 'id-length') xml = xml.replace('id="1"', `id="${'x'.repeat(101)}"`);
    if (rule === 'url-length') xml = xml.replace('https://x.pl/1"', `https://x.pl/${'a'.repeat(1000)}"`);
    if (rule === 'images-count') xml = xml.replace('</imgs>', `${'<i url="https://x.pl/i.jpg"/>'.repeat(20)}</imgs>`);
    expect(rules(await lintText(xml))).toEqual([`ceneo/${rule}`]);
  });

  it('checks text lengths', async () => {
    const xml = offer('', '')
      .replace('<cat>A/B</cat>', `<cat>A/${'b'.repeat(255)}</cat>`)
      .replace('<name>N</name>', `<name>${'n'.repeat(151)}</name>`)
      .replace('<desc>D</desc>', `<desc>${'d'.repeat(100_001)}</desc>`);
    expect(rules(await lintText(xml))).toEqual(['ceneo/cat-length', 'ceneo/desc-length', 'ceneo/name-length']);
  });

  it('counts characters, not bytes', async () => {
    const xml = offer('', '').replace('<name>N</name>', `<name>${'ż'.repeat(150)}</name>`);
    expect(rules(await lintText(xml))).toEqual([]);
  });

  it('caps attributes at 500', async () => {
    const xml = offer('', '').replace('</attrs>', `${Array.from({ length: 500 }, (_, i) => `<a name="A${i}">v</a>`).join('')}</attrs>`);
    expect(rules(await lintText(xml))).toEqual(['ceneo/attrs-count']);
  });

  it('every rule links to the Ceneo guide', () => {
    for (const info of Object.values(CENEO_RULES)) expect(info.url).toContain('ceneo.pl');
  });
});
