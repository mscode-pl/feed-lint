import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const commentModule = '../action/comment.mjs';
const { MARKER, buildBody, run } = await import(commentModule);

const REPORT = '# feed-lint report\n\n1 error, 0 warnings in 1 feed.\n\n## feeds/google.xml\n';
const CLEAN = '# feed-lint report\n\nNo issues in 2 feeds.\n';

interface Call {
  method: string;
  url: string;
  body?: { body: string };
}

function setup(report: string, existing: { id: number; body: string }[], pullRequest = true) {
  const dir = mkdtempSync(join(tmpdir(), 'feed-lint-action-'));
  writeFileSync(join(dir, 'event.json'), JSON.stringify(pullRequest ? { pull_request: { number: 7 } } : {}));
  writeFileSync(join(dir, 'report.md'), report);
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const payload = init.method === 'GET' ? existing : { id: 1 };
    return new Response(JSON.stringify(payload), { status: init.method === 'POST' ? 201 : 200 });
  };
  const env = {
    GITHUB_EVENT_PATH: join(dir, 'event.json'),
    GITHUB_REPOSITORY: 'acme/shop',
    GITHUB_TOKEN: 't',
    REPORT: join(dir, 'report.md'),
    RUN_URL: 'https://github.com/acme/shop/actions/runs/1',
  };
  return { calls, go: () => run(env, fetchFn, () => {}) };
}

describe('pull request comment', () => {
  it('builds a body with the marker, no duplicate title and a run link', () => {
    const { clean, body } = buildBody(REPORT, 'https://example.com/run');
    expect(clean).toBe(false);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).not.toContain('# feed-lint report');
    expect(body).toContain('[workflow run](https://example.com/run)');
    expect(buildBody(CLEAN).clean).toBe(true);
  });

  it('posts a new comment when there are findings', async () => {
    const { calls, go } = setup(REPORT, [{ id: 3, body: 'unrelated' }]);
    expect(await go()).toBe('created');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: expect.stringContaining('/repos/acme/shop/issues/7/comments') });
  });

  it('updates its earlier comment instead of adding another', async () => {
    const { calls, go } = setup(REPORT, [{ id: 3, body: `${MARKER}\nold` }]);
    expect(await go()).toBe('updated');
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: expect.stringContaining('/issues/comments/3') });
  });

  it('marks an earlier comment as clean once the issues are fixed', async () => {
    const { calls, go } = setup(CLEAN, [{ id: 3, body: `${MARKER}\nold` }]);
    expect(await go()).toBe('updated');
    expect(calls.at(-1)?.body?.body).toContain('No issues in 2 feeds.');
  });

  it('stays quiet on a clean first run and outside pull requests', async () => {
    const clean = setup(CLEAN, []);
    expect(await clean.go()).toBe('skipped');
    expect(clean.calls.filter((c) => c.method !== 'GET')).toEqual([]);

    const push = setup(REPORT, [], false);
    expect(await push.go()).toBe('skipped');
    expect(push.calls).toEqual([]);
  });
});
