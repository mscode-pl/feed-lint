import { createReadStream, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFeed, type XmlNode } from '../src/core/parse.js';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

async function parse(name: string, chunkSize?: number) {
  const records: XmlNode[] = [];
  const stream = createReadStream(fixture(name), chunkSize ? { highWaterMark: chunkSize } : {});
  const result = await parseFeed(stream, (record) => records.push(record));
  return { ...result, list: records };
}

const field = (record: XmlNode, name: string) => record.children.find((c) => c.name === name);

describe('parseFeed', () => {
  it('reads Google items with and without the g: prefix', async () => {
    const { info, list, errors } = await parse('google.xml');
    expect(errors).toEqual([]);
    expect(info).toMatchObject({ format: 'google', root: 'rss', encoding: 'UTF-8', googleNamespace: 'http://base.google.com/ns/1.0' });
    expect(list).toHaveLength(2);
    expect(field(list[0], 'id')).toMatchObject({ text: 'A1', line: 7 });
    expect(field(list[0], 'title')?.text).toBe('Plain RSS title');
    expect(field(list[0], 'shipping')?.children.map((c) => c.name)).toEqual(['country', 'price']);
    expect(field(list[1], 'title')).toMatchObject({ text: 'Mug & cup', cdata: true });
  });

  it('reads Ceneo offers, attributes, CDATA and the GPSR lists', async () => {
    const { info, list, responsibleProducers, responsiblePersons } = await parse('ceneo.xml');
    expect(info).toMatchObject({ format: 'ceneo', root: 'offers', rootAttrs: { version: '1' } });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: 'o', line: 9, attrs: { id: '1', price: '12.99', avail: '1' } });
    expect(field(list[0], 'desc')).toMatchObject({ text: '<p>Opis <b>pompy</b></p>', cdata: true });
    expect(field(list[0], 'imgs')?.children.map((c) => c.attrs.url)).toEqual(['https://shop.example/1.jpg', 'https://shop.example/1b.jpg']);
    expect(list[1].attrs).toMatchObject({ update: '1', id: '2', price: '0' });
    expect([...responsibleProducers]).toEqual(['prod-1']);
    expect([...responsiblePersons]).toEqual(['person-1']);
  });

  it('decodes ISO-8859-2', async () => {
    const { info, list, errors } = await parse('ceneo-iso.xml');
    expect(errors).toEqual([]);
    expect(info?.encoding).toBe('ISO-8859-2');
    expect(field(list[0], 'name')?.text).toBe('Zażółć gęślą jaźń');
  });

  it('gives the same result when the file arrives in tiny chunks', async () => {
    const whole = await parse('ceneo.xml');
    const split = await parse('ceneo.xml', 7);
    expect(split.list).toEqual(whole.list);
  });

  it('stops at the first XML error with its line', async () => {
    const { errors, records } = await parse('broken.xml');
    expect(records).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(5);
    expect(errors[0].message).toMatch(/close tag/i);
  });

  it('rejects an unknown root element', async () => {
    const { errors, info } = await parse('unknown.xml');
    expect(info).toBeUndefined();
    expect(errors[0]).toMatchObject({ line: 2, message: expect.stringContaining('<catalog>') });
  });

  it('accepts strings as well as bytes', async () => {
    const records: XmlNode[] = [];
    await parseFeed([readFileSync(fixture('google.xml'), 'utf8')], (r) => records.push(r));
    expect(records).toHaveLength(2);
  });
});
