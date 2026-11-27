import { painter } from '../cli/colors.js';
import { loadConfig } from '../cli/config.js';
import { formatText, type FeedResult } from '../cli/format.js';
import { openInput, USER_AGENT } from '../cli/input.js';
import { fixFor } from '../core/fixes.js';
import { lintFeed, RULES, type LintOptions } from '../core/lint.js';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export class ToolInputError extends Error {}

export const TOOLS = [
  {
    name: 'lint_feed',
    title: 'Lint a product feed',
    description:
      'Check a Google Merchant (RSS or Atom) or Ceneo XML product feed and list problems grouped by rule, with counts, line numbers and product ids: missing fields, wrong prices, invalid GTINs, duplicate ids, bad categories and more. Pass a file path, an http(s) URL or the XML itself. With none of them, lints the feeds from feed-lint.config.json. Follow up with explain_rule for a fix.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Feed file relative to the working directory, e.g. "public/feeds/google.xml". Use one of path, url or xml.' },
        url: { type: 'string', description: 'Feed URL, e.g. "https://shop.example/feed/google.xml".' },
        xml: { type: 'string', description: 'Feed XML as text, for small feeds or a single product.' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Rules to skip, e.g. ["google/identifiers"].' },
        check_urls: {
          type: 'boolean',
          description: 'Also request product links and images (up to 200 unique URLs). Slow; use when asked to check links.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'explain_rule',
    title: 'Explain a feed rule',
    description: 'Explain one rule reported by lint_feed: what it checks, how severe it is, how to fix it and where the specification says so.',
    inputSchema: {
      type: 'object',
      properties: {
        rule: { type: 'string', description: 'Rule id from lint_feed, e.g. "google/gtin-checksum" or "ceneo/avail-value".' },
      },
      required: ['rule'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const text = (value: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  content: [{ type: 'text', text: value }],
  ...extra,
});

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`"${key}" must be a non-empty string.`);
  return value;
}

function optionalList(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ToolInputError(`"${key}" must be an array of strings.`);
  }
  return value as string[];
}

async function lintTool(args: Record<string, unknown>): Promise<ToolResult> {
  const path = optionalString(args, 'path');
  const url = optionalString(args, 'url');
  const xml = optionalString(args, 'xml');
  if ([path, url, xml].filter(Boolean).length > 1) throw new ToolInputError('Pass only one of "path", "url" or "xml".');
  if (url && !/^https?:\/\//i.test(url)) throw new ToolInputError('"url" must start with http:// or https://.');
  if (args.check_urls !== undefined && typeof args.check_urls !== 'boolean') throw new ToolInputError('"check_urls" must be true or false.');

  const config = await loadConfig();
  const ignore = optionalList(args, 'ignore') ?? config.ignore;
  const unknown = (ignore ?? []).filter((r) => !RULES[r]);
  if (unknown.length) throw new ToolInputError(`Unknown rule ${unknown.join(', ')}.`);
  const options: LintOptions = {
    ignore,
    checkUrls: (args.check_urls ?? config.checkUrls) ? { limit: config.urlLimit, userAgent: USER_AGENT } : false,
  };

  const results: FeedResult[] = [];
  if (xml) {
    results.push({ feed: '<xml>', ...(await lintFeed([xml], options)) });
  } else {
    const feeds = path ? [path] : url ? [url] : (config.feeds ?? []);
    if (!feeds.length) throw new ToolInputError('Pass "path", "url" or "xml". There is no feed-lint.config.json with "feeds" to fall back on.');
    for (const feed of feeds) results.push({ feed, ...(await lintFeed(await openInput(feed), options)) });
  }
  return text(formatText(results, { verbose: true, paint: painter(false) }));
}

function explainRule(args: Record<string, unknown>): ToolResult {
  const rule = optionalString(args, 'rule');
  if (!rule) throw new ToolInputError('"rule" is required.');
  const info = RULES[rule];
  if (!info) {
    const words = (rule.split('/').pop() ?? '').split('-').filter((w) => w.length > 2);
    const similar = Object.keys(RULES)
      .filter((r) => words.some((w) => (r.split('/').pop() ?? '').includes(w)))
      .slice(0, 8);
    throw new ToolInputError(`Unknown rule "${rule}".${similar.length ? ` Similar: ${similar.join(', ')}.` : ''}`);
  }
  const severity = info.level === 'error' ? 'Error: the product or the whole feed is rejected.' : 'Warning: the product is accepted but may be limited or disapproved later.';
  return text([`${info.title} (${rule})`, severity, '', `Fix: ${fixFor(rule)}`, '', `Source: ${info.url}`].join('\n'));
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (name === 'lint_feed') return await lintTool(args);
    if (name === 'explain_rule') return explainRule(args);
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), { isError: true });
  }
  throw new ToolInputError(`Unknown tool "${name}".`);
}
