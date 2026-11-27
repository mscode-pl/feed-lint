import { describe, expect, it } from 'vitest';
import { formatMarkdown } from '../src/cli/format.js';
import { lintFeed } from '../src/core/lint.js';
import { parseFeed, type XmlNode } from '../src/core/parse.js';
import { promoText } from '../src/rules/text.js';

const rules = async (input: Parameters<typeof lintFeed>[0]) => (await lintFeed(input)).results.map((r) => r.rule).sort();

const PRODUCT = (extra: string) =>
  `<g:title>Mug</g:title><g:description>Mug</g:description><g:link>https://x.pl/m</g:link>` +
  `<g:image_link>https://x.pl/m.jpg</g:image_link><g:availability>in_stock</g:availability><g:price>10.00 PLN</g:price>` +
  `<g:identifier_exists>no</g:identifier_exists>${extra}`;

const rss = (...items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>${items.map((i) => `<item>${i}</item>`).join('')}</channel></rss>`;

// "żółty łódź" in Windows-1250.
const CP1250 = [0xbf, 0xf3, 0xb3, 0x74, 0x79, 0x20, 0xb3, 0xf3, 0x64, 0x9f];
const bytes = (head: string, body: number[], tail: string) => new Uint8Array([...Buffer.from(head), ...body, ...Buffer.from(tail)]);

function chunked(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}

describe('Atom feeds', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0">
<entry>
  <id>tag:shop.example,2026:products/a-very-long-atom-identifier-that-is-not-the-product-id</id>
  <updated>2026-11-27T10:00:00Z</updated>
  <title>Mug</title>
  <summary>White mug</summary>
  <link rel="self" href="https://shop.example/feed/1"/>
  <link rel="alternate" href="https://shop.example/mug"/>
  <g:id>SKU-1</g:id>
  <g:image_link>https://shop.example/mug.jpg</g:image_link>
  <g:availability>in_stock</g:availability>
  <g:price>10.00 PLN</g:price>
  <g:identifier_exists>no</g:identifier_exists>
</entry>
</feed>`;

  it('uses g:id, the alternate link and summary as the description', async () => {
    const result = await lintFeed([atom]);
    expect(result.results).toEqual([]);
  });

  it('checks the alternate link, not the self link', async () => {
    const result = await lintFeed([atom.replace('href="https://shop.example/mug"', 'href="shop.example/mug"')]);
    expect(result.results.map((r) => r.rule)).toEqual(['google/url-scheme']);
  });
});

describe('false positives found in review', () => {
  it('accepts dates with fractional seconds', async () => {
    const xml = rss(`<g:id>1</g:id>${PRODUCT('')}`.replace('in_stock', 'preorder') + '<g:availability_date>2026-12-01T10:00:00.000Z</g:availability_date>');
    expect(await rules([xml])).toEqual([]);
  });

  it.each([
    ['Sukienka wieczorowa na każdą okazję', undefined],
    ['T-shirt bawełna 95% - 5% elastan', undefined],
    ['Gratisowy brelok', undefined],
    ['Kurtka -50%', '-50%'],
    ['Kubek + gratis', 'gratis'],
    ['Super okazja na kubek', 'Super okazja'],
  ])('promo text in "%s"', (title, match) => {
    expect(promoText(title)?.trim()).toBe(match);
  });

  it('accepts lower case currency and extra spaces', async () => {
    expect(await rules([rss(`<g:id>1</g:id>${PRODUCT('')}`.replace('10.00 PLN', '10.00  pln'))])).toEqual([]);
  });

  it('names the thousands separator', async () => {
    const result = await lintFeed([rss(`<g:id>1</g:id>${PRODUCT('')}`.replace('10.00 PLN', '1,299.00 PLN'))]);
    expect(result.results[0].samples[0].detail).toContain('remove the thousands separator');
  });

  it('accepts the older A+++ energy scale on Ceneo', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><offers version="1"><o id="1" url="https://x.pl/1" price="1.00" avail="1"><cat>A/B</cat><name>Piekarnik</name><imgs><main url="https://x.pl/1.jpg"/></imgs><desc>D</desc><attrs><a name="Marka">M</a><a name="Klasa energetyczna">A+++</a></attrs></o></offers>`;
    expect(await rules([xml])).toEqual([]);
  });
});

describe('XML and encoding', () => {
  it('rejects HTML entities that XML does not define', async () => {
    expect(await rules([rss(`<g:id>1</g:id>${PRODUCT('')}`.replace('<g:title>Mug', '<g:title>Mug&nbsp;300'))])).toEqual(['xml/parse']);
  });

  it('finds the encoding when the declaration arrives in tiny chunks', async () => {
    const data = bytes('<?xml version="1.0" encoding="windows-1250"?><offers version="1"><o id="1"><name>', CP1250, '</name></o></offers>');
    const names: string[] = [];
    await parseFeed(chunked(data, 7), (record: XmlNode) => names.push(record.children[0].text));
    expect(names).toEqual(['żółty łódź']);
  });

  it('reports bytes that do not match the declared encoding', async () => {
    const data = bytes('<?xml version="1.0" encoding="UTF-8"?><offers version="1"><o id="1"><name>', CP1250, '</name></o></offers>');
    expect(await rules([data])).toEqual(['xml/encoding']);
  });
});

describe('Ceneo GPSR order', () => {
  it('says when the lists come after the offers', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><offers version="1"><o id="1" url="https://x.pl/1" price="1.00" avail="1"><cat>A/B</cat><name>N</name><imgs><main url="https://x.pl/1.jpg"/></imgs><desc>D</desc><attrs><a name="Marka">M</a><a name="Producent odpowiedzialny">p1</a></attrs></o><responsibleProducers><p id="p1"><name>Acme</name></p></responsibleProducers></offers>`;
    const result = await lintFeed([xml]);
    expect(result.results[0]).toMatchObject({ rule: 'ceneo/gpsr-reference', samples: [{ detail: expect.stringContaining('declared after the offers') }] });
  });
});

describe('pull request comment', () => {
  it('does not mention GitHub users from feed text', async () => {
    const result = await lintFeed([rss(`<g:id>@octocat</g:id>`)]);
    expect(formatMarkdown([{ feed: 'f.xml', ...result }])).not.toContain('@octocat');
  });
});
