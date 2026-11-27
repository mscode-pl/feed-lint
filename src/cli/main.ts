#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { lintFeed, RULES, type LintOptions } from '../core/lint.js';
import { painter } from './colors.js';
import { CONFIG_FILE, FAIL_ON, loadConfig, type FailOn } from './config.js';
import { FORMATS, formatFromPath, onlyErrors, render, type FeedResult, type Format } from './format.js';
import { openInput, USER_AGENT } from './input.js';

const HELP = `Usage: feed-lint <files or URLs...> [options]
       feed-lint mcp    Start an MCP server on stdio for AI agents

Checks Google Merchant (RSS, Atom) and Ceneo XML product feeds before you
upload them. Files may be gzipped (.gz).

Options:
  -i, --ignore <list>    Rules to skip, e.g. google/identifiers,ceneo/brand
      --check-urls       Also request product links and images
      --url-limit <n>    Unique URLs to check per feed, 0 for all (default: 200)
  -f, --format <type>    ${FORMATS.join(', ')} (default: text)
  -o, --output <file>    Also save the report; format follows the extension
                         (.json, .md, anything else is plain text)
      --verbose          Show more examples and links to the specification
  -q, --quiet            Report errors only
      --fail-on <level>  ${FAIL_ON.join(', ')} (default: error)
      --config <file>    Config file (default: ${CONFIG_FILE} if present)
      --stdin            Read the feed from stdin
      --rules            List all rules
  -v, --version          Print version
  -h, --help             Show this help

Examples:
  feed-lint google.xml
  feed-lint https://shop.example/feed/ceneo.xml --check-urls
  feed-lint feeds/*.xml -o feed-report.md
  curl -s https://shop.example/google.xml | feed-lint --stdin --format json`;

const list = (value: string | undefined) =>
  value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function version(): string {
  return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
}

function listRules(): string {
  const width = Math.max(...Object.keys(RULES).map((r) => r.length));
  return Object.entries(RULES)
    .map(([rule, info]) => `${rule.padEnd(width)}  ${info.level.padEnd(7)}  ${info.title}`)
    .join('\n');
}

async function main(): Promise<number> {
  if (process.argv[2] === 'mcp' && process.argv.length === 3) {
    const { serve } = await import('../mcp/server.js');
    await serve();
    return 0;
  }

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ignore: { type: 'string', short: 'i' },
      'check-urls': { type: 'boolean' },
      'url-limit': { type: 'string' },
      verbose: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      format: { type: 'string', short: 'f', default: 'text' },
      output: { type: 'string', short: 'o' },
      'fail-on': { type: 'string' },
      config: { type: 'string' },
      stdin: { type: 'boolean', default: false },
      rules: { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(version());
    return 0;
  }
  if (values.rules) {
    console.log(listRules());
    return 0;
  }

  const config = await loadConfig(values.config);
  const inputs = positionals.length ? positionals : (config.feeds ?? []);
  if (!inputs.length && !values.stdin) {
    console.log(HELP);
    return 2;
  }

  const format = values.format as Format;
  if (!FORMATS.includes(format)) {
    console.error(`Unknown format "${values.format}". Use ${FORMATS.join(', ')}.`);
    return 2;
  }
  const failOn = (values['fail-on'] ?? config.failOn ?? 'error') as FailOn;
  if (!FAIL_ON.includes(failOn)) {
    console.error(`Unknown --fail-on "${failOn}". Use ${FAIL_ON.join(', ')}.`);
    return 2;
  }
  const urlLimit = values['url-limit'] !== undefined ? Number(values['url-limit']) : config.urlLimit;
  if (urlLimit !== undefined && (!Number.isInteger(urlLimit) || urlLimit < 0)) {
    console.error(`--url-limit must be a whole number, 0 for all.`);
    return 2;
  }

  const ignore = list(values.ignore) ?? config.ignore ?? [];
  const unknown = ignore.filter((r) => !RULES[r]);
  if (unknown.length) {
    console.error(`Unknown rule ${unknown.join(', ')}. Run feed-lint --rules for the list.`);
    return 2;
  }

  const options: LintOptions = {
    ignore,
    checkUrls: (values['check-urls'] ?? config.checkUrls) ? { limit: urlLimit, userAgent: USER_AGENT } : false,
  };

  let results: FeedResult[] = [];
  const sources = values.stdin ? ['<stdin>'] : inputs;
  for (const feed of sources) {
    try {
      const chunks = feed === '<stdin>' ? process.stdin : await openInput(feed);
      results.push({ feed, ...(await lintFeed(chunks, options)) });
    } catch (error) {
      results.push({ feed, format: undefined, records: 0, errors: 1, warnings: 0, results: [], fatal: (error as Error).message });
    }
  }

  if (values.quiet) results = onlyErrors(results);

  console.log(render(results, format, { verbose: values.verbose }));
  if (values.output) {
    await writeFile(values.output, render(results, formatFromPath(values.output), { paint: painter(false), verbose: true }));
    if (format === 'text') console.log(`Report saved to ${values.output}`);
  }

  if (results.some((r) => r.fatal)) return 2;
  const errors = results.reduce((n, r) => n + r.errors, 0);
  const warnings = results.reduce((n, r) => n + r.warnings, 0);
  if (failOn === 'error' && errors) return 1;
  if (failOn === 'warning' && (errors || warnings)) return 1;
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
