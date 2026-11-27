import { CENEO_RULES, ceneoChecker, ceneoFileChecks } from '../rules/ceneo.js';
import { GOOGLE_RULES, googleChecker } from '../rules/google.js';
import { type Chunks, type FeedFormat, type ParseResult, parseFeed, type XmlNode } from './parse.js';
import { Collector, type Report, type RuleInfo, type RuleResult } from './report.js';
import { URL_RULES, UrlCollector, type UrlCheckOptions, type UrlStats } from './urls.js';

const XML_RULES: Record<string, RuleInfo> = {
  'xml/parse': { level: 'error', title: 'The file is not valid XML', url: 'https://www.w3.org/TR/xml/' },
  'xml/format-unknown': {
    level: 'error',
    title: 'Not a Google Merchant (<rss>, <feed>) or Ceneo (<offers>) feed',
    url: 'https://github.com/mscode-pl/feed-lint#formats',
  },
  'xml/encoding': { level: 'error', title: 'Unsupported encoding in the XML declaration', url: 'https://www.w3.org/TR/xml/#charencoding' },
};

export const RULES: Record<string, RuleInfo> = { ...XML_RULES, ...GOOGLE_RULES, ...CENEO_RULES, ...URL_RULES };

export interface LintOptions {
  ignore?: string[];
  maxSamples?: number;
  checkUrls?: boolean | UrlCheckOptions;
}

export interface LintResult {
  format: FeedFormat | undefined;
  records: number;
  errors: number;
  warnings: number;
  results: RuleResult[];
  urls?: UrlStats;
}

type Checker = ((record: XmlNode) => void) & { end?: () => void };

const CHECKERS: Record<FeedFormat, (report: Report, parsed: ParseResult) => Checker> = {
  google: googleChecker,
  ceneo: ceneoChecker,
};

export async function lintFeed(chunks: Chunks, options: LintOptions = {}): Promise<LintResult> {
  const collector = new Collector(RULES, new Set(options.ignore), options.maxSamples ?? 20);
  let check: Checker | undefined;
  const urlOptions = typeof options.checkUrls === 'object' ? options.checkUrls : {};
  const urls = options.checkUrls ? new UrlCollector(urlOptions.limit ?? 200) : undefined;

  const parsed = await parseFeed(chunks, (record, info, state) => {
    check ??= CHECKERS[info.format](collector.report, state);
    check(record);
    urls?.add(record, info.format, info.root === 'feed');
  });

  check?.end?.();
  if (parsed.info?.format === 'ceneo') ceneoFileChecks(parsed.info, collector.report);

  for (const error of parsed.errors) {
    const rule = error.kind === 'format' ? 'xml/format-unknown' : error.kind === 'encoding' ? 'xml/encoding' : 'xml/parse';
    collector.report(rule, { line: error.line, detail: error.message });
  }

  let stats: UrlStats | undefined;
  if (urls && !parsed.errors.length) {
    stats = await urls.check(collector.report, urlOptions);
  }

  return { ...summarize(parsed.info?.format, parsed.records, collector.list()), ...(stats ? { urls: stats } : {}) };
}

export function summarize(format: FeedFormat | undefined, records: number, results: RuleResult[]): LintResult {
  const sum = (level: string) => results.filter((r) => r.level === level).reduce((n, r) => n + r.count, 0);
  return { format, records, errors: sum('error'), warnings: sum('warning'), results };
}
