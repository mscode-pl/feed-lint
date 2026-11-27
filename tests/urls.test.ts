import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintFeed } from '../src/core/lint.js';

let server: Server;
let base = '';
const methods: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    if (req.url === '/ok.jpg') return res.writeHead(200).end();
    if (req.url === '/moved') return res.writeHead(301, { location: '/ok.jpg' }).end();
    if (req.url === '/no-head' && req.method === 'HEAD') return res.writeHead(405).end();
    if (req.url === '/no-head') return res.writeHead(200).end();
    if (req.url === '/slow') return setTimeout(() => res.writeHead(200).end(), 500);
    if (req.url === '/forbidden') return res.writeHead(403).end();
    if (req.url === '/busy') return res.writeHead(429, { 'retry-after': '0' }).end();
    if (req.url === '/bad-location') return res.writeHead(302, { location: 'http://[bad' }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const item = (id: string, link: string, image: string) =>
  `<item><g:id>${id}</g:id><g:link>${base}${link}</g:link><g:image_link>${base}${image}</g:image_link></item>`;

const feed = (...items: string[]) => `<rss xmlns:g="http://base.google.com/ns/1.0"><channel>${items.join('')}</channel></rss>`;

const IGNORE = ['google/missing-title', 'google/missing-description', 'google/missing-availability', 'google/missing-price', 'google/identifiers', 'google/http'];

describe('--check-urls', () => {
  it('reports broken links, redirects and timeouts once per URL', async () => {
    const xml = feed(item('1', '/ok.jpg', '/missing.jpg'), item('2', '/moved', '/missing.jpg'), item('3', '/no-head', '/slow'));
    const result = await lintFeed([xml], { ignore: IGNORE, checkUrls: { timeoutMs: 200 } });
    const byRule = Object.fromEntries(result.results.map((r) => [r.rule, r.samples.map((s) => `${s.id} ${s.detail?.split('  ')[0]}`)]));
    expect(byRule).toEqual({
      'url/unreachable': expect.arrayContaining(['1 image_link: HTTP 404', '3 image_link: timeout']),
      'url/redirect': [`2 link: HTTP 301 to ${base}/ok.jpg`],
    });
    expect(byRule['url/unreachable']).toHaveLength(2);
    expect(result.urls).toEqual({ total: 5, checked: 5 });
    expect(methods).toContain('GET /no-head');
  });

  it('stops at the limit but still counts every unique URL', async () => {
    const xml = feed(item('1', '/a', '/b'), item('2', '/c', '/d'), item('3', '/c', '/e'));
    const result = await lintFeed([xml], { ignore: IGNORE, checkUrls: { limit: 3 } });
    expect(result.urls).toEqual({ total: 5, checked: 3 });
  });

  it('reports 403 and 429 as blocked, not unreachable, and retries 429 once', async () => {
    methods.length = 0;
    const xml = feed(item('1', '/forbidden', '/busy'), item('2', '/bad-location', '/ok.jpg'));
    const result = await lintFeed([xml], { ignore: IGNORE, checkUrls: true });
    const byRule = Object.fromEntries(result.results.map((r) => [r.rule, r.samples.map((s) => s.detail?.split('  ')[0])]));
    expect(byRule).toEqual({
      'url/blocked': expect.arrayContaining(['link: HTTP 403', 'image_link: HTTP 429']),
      'url/redirect': ['link: HTTP 302 to an invalid Location'],
    });
    expect(methods.filter((m) => m === 'HEAD /busy')).toHaveLength(2);
  });

  it('collects Ceneo offer and image URLs', async () => {
    const xml = `<offers version="1"><o id="1" url="${base}/x" price="1" avail="1"><imgs><main url="${base}/ok.jpg"/></imgs></o></offers>`;
    const result = await lintFeed([xml], { checkUrls: true });
    expect(result.urls).toEqual({ total: 2, checked: 2 });
    expect(result.results.find((r) => r.rule === 'url/unreachable')?.samples[0].detail).toContain('url: HTTP 404');
  });

  it('skips URL checks when the XML is broken', async () => {
    const result = await lintFeed([`${feed(item('1', '/x', '/y'))}<oops`], { checkUrls: true });
    expect(result.urls).toBeUndefined();
  });
});
