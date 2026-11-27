import type { LintResult } from '../core/lint.js';
import type { RuleResult, Sample } from '../core/report.js';
import { painter, type Paint } from './colors.js';

export interface FeedResult extends LintResult {
  feed: string;
  fatal?: string;
}

export type Format = 'text' | 'json' | 'markdown' | 'github';
export const FORMATS: Format[] = ['text', 'json', 'markdown', 'github'];

const FORMAT_NAMES = { google: 'Google Merchant', ceneo: 'Ceneo' };
const RECORD_NAMES = { google: 'product', ceneo: 'offer' };

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

export function describeFeed(result: FeedResult): string {
  if (result.fatal) return 'not read';
  if (!result.format) return 'unknown format';
  const urls = result.urls ? `, ${result.urls.checked.toLocaleString('en')} of ${plural(result.urls.total, 'URL')} checked` : '';
  return `${FORMAT_NAMES[result.format]}, ${plural(result.records, RECORD_NAMES[result.format])}${urls}`;
}

export function summary(results: FeedResult[]): string {
  const errors = results.reduce((n, r) => n + r.errors, 0);
  const warnings = results.reduce((n, r) => n + r.warnings, 0);
  const feeds = plural(results.length, 'feed');
  if (results.some((r) => r.fatal)) return `${plural(results.filter((r) => r.fatal).length, 'feed')} could not be read.`;
  if (!errors && !warnings) return `No issues in ${feeds}.`;
  return `${plural(errors, 'error')}, ${plural(warnings, 'warning')} in ${feeds}.`;
}

export function formatSample(s: Sample): string {
  return [`line ${s.line}`, s.id && `id ${s.id}`, s.detail].filter(Boolean).join('  ');
}

export interface TextOptions {
  verbose?: boolean;
  samples?: number;
  paint?: Paint;
}

export function formatText(results: FeedResult[], options: TextOptions = {}): string {
  const paint = options.paint ?? painter();
  const shown = options.verbose ? Infinity : (options.samples ?? 3);
  const out: string[] = [];

  for (const result of results) {
    out.push(`${paint('underline', result.feed)}  ${paint('dim', describeFeed(result))}`);
    if (result.fatal) {
      out.push(`  ${paint('red', 'error')}  ${result.fatal}`, '');
      continue;
    }
    if (!result.results.length) {
      out.push(`  ${paint('green', 'no issues')}`, '');
      continue;
    }
    const countWidth = Math.max(...result.results.map((r) => r.count.toLocaleString('en').length));
    for (const r of result.results) {
      const level = r.level === 'error' ? paint('red', 'error  ') : paint('yellow', 'warning');
      out.push(`  ${level}  ${r.count.toLocaleString('en').padStart(countWidth)}  ${paint('bold', r.title)}  ${paint('dim', r.rule)}`);
      const pad = ' '.repeat(2 + 7 + 2 + countWidth + 2);
      for (const s of r.samples.slice(0, shown)) out.push(`${pad}${formatSample(s)}`);
      const more = r.count - Math.min(r.samples.length, shown);
      if (more > 0) out.push(paint('dim', `${pad}and ${more.toLocaleString('en')} more`));
      if (options.verbose) out.push(paint('dim', `${pad}${r.url}`));
    }
    out.push('');
  }

  const clean = results.every((r) => !r.fatal && !r.results.length);
  out.push(clean ? paint('green', summary(results)) : summary(results));
  if (results.some((r) => r.results.length) && !options.verbose) out.push(paint('dim', 'Add --verbose for more examples and links to the specification.'));
  return out.join('\n');
}

// Feed text lands in a pull request comment, where "@name" would notify a GitHub user.
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('@', '&#64;').replace(/\s*\n\s*/g, ' ');

export function formatMarkdown(results: FeedResult[], samples = 5): string {
  const out = ['# feed-lint report', '', summary(results), ''];
  for (const result of results) {
    out.push(`## ${cell(result.feed)}`, '', `${describeFeed(result)}.`, '');
    if (result.fatal) {
      out.push(`Could not read the feed: ${cell(result.fatal)}`, '');
      continue;
    }
    if (!result.results.length) {
      out.push('No issues.', '');
      continue;
    }
    out.push('| Level | Count | Rule | Examples |', '| --- | ---: | --- | --- |');
    for (const r of result.results) {
      const examples = r.samples
        .slice(0, samples)
        .map((s) => cell(formatSample(s)))
        .join('<br>');
      out.push(`| ${r.level} | ${r.count} | [${cell(r.title)}](${r.url}) \`${r.rule}\` | ${examples} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

// Workflow command escaping: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function formatGithub(results: FeedResult[], samples = 5): string {
  const out: string[] = [];
  for (const result of results) {
    const file = escapeProperty(result.feed.replaceAll('\\', '/'));
    if (result.fatal) {
      out.push(`::error file=${file},title=feed-lint::${escapeData(result.fatal)}`);
      continue;
    }
    for (const r of result.results) {
      const title = escapeProperty(`feed-lint: ${r.title}`);
      const total = r.count > 1 ? ` (${r.count} in this feed)` : '';
      for (const s of r.samples.slice(0, samples)) {
        const message = [s.id && `id ${s.id}`, s.detail].filter(Boolean).join(': ');
        out.push(`::${r.level} file=${file},line=${s.line},title=${title}::${escapeData(`${message || r.title}${total}. ${r.rule} ${r.url}`)}`);
      }
    }
  }
  out.push(summary(results));
  return out.join('\n');
}

export function render(results: FeedResult[], format: Format, options: TextOptions = {}): string {
  if (format === 'json') return JSON.stringify(results.map(({ feed, fatal, ...rest }) => ({ feed, ...(fatal ? { fatal } : {}), ...rest })), null, 2);
  if (format === 'markdown') return formatMarkdown(results);
  if (format === 'github') return formatGithub(results);
  return formatText(results, options);
}

export function onlyErrors(results: FeedResult[]): FeedResult[] {
  return results.map((r) => ({ ...r, results: r.results.filter((x: RuleResult) => x.level === 'error'), warnings: 0 }));
}

export function formatFromPath(path: string): Format {
  if (/\.json$/i.test(path)) return 'json';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  return 'text';
}
