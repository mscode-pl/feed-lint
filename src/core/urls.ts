import { productFields } from '../rules/google.js';
import type { FeedFormat, XmlNode } from './parse.js';
import type { Report, RuleInfo, Sample } from './report.js';

const DOCS = 'https://github.com/mscode-pl/feed-lint#what-it-checks';

export const URL_RULES: Record<string, RuleInfo> = {
  'url/unreachable': { level: 'error', title: 'Link or image does not load (HTTP 404, 5xx, timeout or network error)', url: DOCS },
  'url/blocked': {
    level: 'warning',
    title: 'Link or image refused the check (HTTP 401, 403 or 429); make sure Googlebot and the Ceneo crawler are allowed',
    url: DOCS,
  },
  'url/redirect': { level: 'warning', title: 'Link or image redirects; use the final URL', url: DOCS },
};

export interface UrlCheckOptions {
  // 0 checks every unique URL.
  limit?: number;
  concurrency?: number;
  timeoutMs?: number;
  userAgent?: string;
  fetch?: typeof fetch;
}

export interface UrlStats {
  total: number;
  checked: number;
}

const GOOGLE_URL_FIELDS = ['link', 'mobile_link', 'image_link', 'additional_image_link'];

// FNV-1a; only used to count unique URLs past the limit without keeping them in memory.
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export class UrlCollector {
  private readonly urls = new Map<string, Sample>();
  private readonly overflow = new Set<number>();

  constructor(private readonly limit = 200) {}

  add(record: XmlNode, format: FeedFormat, atom = false): void {
    if (format === 'google') {
      const fields = productFields(record, atom);
      const id = fields.get('id')?.[0]?.text.trim() || undefined;
      for (const name of GOOGLE_URL_FIELDS) {
        for (const c of fields.get(name) ?? []) this.put(c.text.trim() || c.attrs.href?.trim(), { line: c.line, id, detail: name });
      }
    } else {
      const id = record.attrs.id?.trim() || undefined;
      this.put(record.attrs.url?.trim(), { line: record.line, id, detail: 'url' });
      for (const img of record.children.find((c) => c.name === 'imgs')?.children ?? []) {
        this.put(img.attrs.url?.trim(), { line: img.line, id, detail: `<${img.name}>` });
      }
    }
  }

  private put(url: string | undefined, sample: Sample): void {
    if (!url || !/^https?:\/\//i.test(url) || this.urls.has(url)) return;
    if (this.limit > 0 && this.urls.size >= this.limit) this.overflow.add(hash(url));
    else this.urls.set(url, sample);
  }

  async check(report: Report, options: UrlCheckOptions = {}): Promise<UrlStats> {
    const entries = [...this.urls];
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const [url, sample] = entries[next++];
        const problem = await probe(url, options);
        if (problem) report(problem.rule, { ...sample, detail: `${sample.detail}: ${problem.detail}  ${url}` });
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 8, entries.length) }, worker));
    return { total: this.urls.size + this.overflow.size, checked: entries.length };
  }
}

interface Problem {
  rule: 'url/unreachable' | 'url/blocked' | 'url/redirect';
  detail: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(url: string, options: UrlCheckOptions): Promise<Problem | undefined> {
  const doFetch = options.fetch ?? fetch;
  const request = async (method: 'HEAD' | 'GET') => {
    const response = await doFetch(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: options.userAgent ? { 'user-agent': options.userAgent } : {},
    });
    await response.body?.cancel();
    return response;
  };

  try {
    let response = await request('HEAD');
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after'));
      await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000, 5000));
      response = await request('HEAD');
    }
    // Some servers and CDNs refuse HEAD; the browser would use GET.
    if ([403, 405, 501].includes(response.status)) response = await request('GET');
    const status = response.status;
    if (status >= 300 && status < 400) {
      let target = '';
      try {
        const location = response.headers.get('location');
        if (location) target = ` to ${new URL(location, url).href}`;
      } catch {
        target = ' to an invalid Location';
      }
      return { rule: 'url/redirect', detail: `HTTP ${status}${target}` };
    }
    if (status === 401 || status === 403 || status === 429) return { rule: 'url/blocked', detail: `HTTP ${status}` };
    if (status >= 400) return { rule: 'url/unreachable', detail: `HTTP ${status}` };
    return undefined;
  } catch (error) {
    const e = error as Error & { cause?: { code?: string } };
    const detail = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message);
    return { rule: 'url/unreachable', detail };
  }
}
