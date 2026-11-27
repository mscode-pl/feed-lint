import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/cli/config.js';
import { formatGithub, formatMarkdown, formatText, onlyErrors, type FeedResult } from '../src/cli/format.js';
import { lintFeed } from '../src/core/lint.js';
import { painter } from '../src/cli/colors.js';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url);
const fixture = (name: string) => join(ROOT.pathname.replace(/^\/([A-Z]:)/, '$1'), 'tests', 'fixtures', name);
const tmp = mkdtempSync(join(tmpdir(), 'feed-lint-'));

async function cli(...args: string[]) {
  try {
    const { stdout } = await run(process.execPath, ['dist/cli/main.js', ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout + e.stderr };
  }
}

async function result(name: string): Promise<FeedResult> {
  return { feed: name, ...(await lintFeed([readFileSync(fixture(name), 'utf8')])) };
}

describe('formatters', () => {
  it('groups text output by rule with examples and a remainder', async () => {
    const text = formatText([await result('google-bad.xml')], { paint: painter(false), samples: 1 });
    expect(text).toContain('google-bad.xml  Google Merchant, 3 products');
    expect(text).toMatch(/error +1 +The same g:id is used by more than one product +google\/duplicate-id/);
    expect(text).toContain('line 18  id A  first used on line 5');
    expect(text).toMatch(/errors?, \d+ warnings? in 1 feed\./);
  });

  it('says so when a feed is clean', async () => {
    expect(formatText([await result('google-good.xml')], { paint: painter(false) })).toContain('No issues in 1 feed.');
  });

  it('writes a markdown table', async () => {
    const md = formatMarkdown([await result('ceneo-bad.xml')]);
    expect(md).toContain('| Level | Count | Rule | Examples |');
    expect(md).toContain('`ceneo/avail-value`');
  });

  it('writes GitHub annotations with escaped properties', async () => {
    const gh = formatGithub([{ ...(await result('google-bad.xml')), feed: 'feeds\\a,b.xml' }]);
    expect(gh).toContain('::error file=feeds/a%2Cb.xml,line=18,title=feed-lint%3A The same g%3Aid');
    expect(gh).toMatch(/::warning file=/);
  });

  it('drops warnings with --quiet', async () => {
    const [quiet] = onlyErrors([await result('google-bad.xml')]);
    expect(quiet.results.every((r) => r.level === 'error')).toBe(true);
    expect(quiet.warnings).toBe(0);
  });
});

describe('config', () => {
  it('reads and validates feed-lint.config.json', async () => {
    const file = join(tmp, 'ok.json');
    writeFileSync(file, JSON.stringify({ feeds: ['a.xml'], ignore: ['ceneo/brand'], failOn: 'warning', checkUrls: true, urlLimit: 0 }));
    expect(await loadConfig(file)).toEqual({ feeds: ['a.xml'], ignore: ['ceneo/brand'], failOn: 'warning', checkUrls: true, urlLimit: 0 });
  });

  it('rejects unknown keys and wrong types', async () => {
    const file = join(tmp, 'bad.json');
    writeFileSync(file, JSON.stringify({ files: [] }));
    await expect(loadConfig(file)).rejects.toThrow(/unknown option files/);
    writeFileSync(file, JSON.stringify({ urlLimit: -1 }));
    await expect(loadConfig(file)).rejects.toThrow(/urlLimit/);
  });

  it('returns an empty config when the default file is missing', async () => {
    expect(await loadConfig()).toEqual({});
  });
});

describe('cli', () => {
  beforeAll(async () => {
    await run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT });
  }, 60_000);

  it('exits 0 for a clean feed and 1 for errors', async () => {
    expect((await cli(fixture('google-good.xml'))).code).toBe(0);
    const bad = await cli(fixture('google-bad.xml'));
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('google/duplicate-id');
  });

  it('exits 2 for a missing file, an unknown rule or format', async () => {
    expect(await cli('missing.xml')).toMatchObject({ code: 2, stdout: expect.stringContaining('file not found') });
    expect((await cli(fixture('google-bad.xml'), '-i', 'nope/rule')).code).toBe(2);
    expect((await cli(fixture('google-bad.xml'), '-f', 'xml')).code).toBe(2);
  });

  it('honours --fail-on', async () => {
    expect((await cli(fixture('google-bad.xml'), '--fail-on', 'never')).code).toBe(0);
  });

  it('prints JSON', async () => {
    const { stdout } = await cli(fixture('ceneo-good.xml'), '-f', 'json');
    expect(JSON.parse(stdout)).toMatchObject([{ format: 'ceneo', records: 3, errors: 0, results: [] }]);
  });

  it('reads gzipped feeds', async () => {
    const file = join(tmp, 'feed.xml.gz');
    writeFileSync(file, gzipSync(readFileSync(fixture('google-good.xml'))));
    expect(await cli(file)).toMatchObject({ code: 0, stdout: expect.stringContaining('Google Merchant, 2 products') });
  });

  it('saves a report with -o', async () => {
    const out = join(tmp, 'report.md');
    await cli(fixture('ceneo-bad.xml'), '-o', out);
    expect(readFileSync(out, 'utf8')).toContain('# feed-lint report');
  });

  it('lists rules', async () => {
    const { stdout } = await cli('--rules');
    expect(stdout).toMatch(/^google\/duplicate-id +error/m);
    expect(stdout).toMatch(/^ceneo\/avail-value +error/m);
  });
});
