// Posts the feed-lint report as one pull request comment and updates it on every run.
// Runs on the bare runner Node, so it uses no dependencies.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- feed-lint-report -->';
const MAX_BODY = 60000;

export function buildBody(markdown, runUrl) {
  let report = markdown.replace(/^# feed-lint report\s*\n/, '').trim();
  const clean = /^No issues in /.test(report);
  if (report.length > MAX_BODY) {
    report = `${report.slice(0, MAX_BODY)}\n\n_Report cut short. The full report is in the workflow run._`;
  }
  const footer = runUrl ? `\n\n<sub>[feed-lint](https://github.com/mscode-pl/feed-lint) · [workflow run](${runUrl})</sub>` : '';
  return { clean, body: `${MARKER}\n### feed-lint\n\n${report}${footer}\n` };
}

async function github(fetchFn, env, method, path, body) {
  const response = await fetchFn(`${env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'mscode-pl/feed-lint-action',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function findComment(fetchFn, env, repo, number) {
  for (let page = 1; ; page++) {
    const comments = await github(fetchFn, env, 'GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    const found = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
    if (found) return found;
    if (comments.length < 100) return undefined;
  }
}

export async function run(env = process.env, fetchFn = fetch, log = console.log) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.pull_request?.number;
  if (!number) {
    log('Not a pull request, so no comment is posted.');
    return 'skipped';
  }

  const repo = env.GITHUB_REPOSITORY;
  const { clean, body } = buildBody(await readFile(env.REPORT, 'utf8'), env.RUN_URL);
  const existing = await findComment(fetchFn, env, repo, number);

  if (existing) {
    await github(fetchFn, env, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
    log(`Updated the feed-lint comment on #${number}.`);
    return 'updated';
  }
  if (clean) {
    log('No issues and no earlier comment, so nothing is posted.');
    return 'skipped';
  }
  await github(fetchFn, env, 'POST', `/repos/${repo}/issues/${number}/comments`, { body });
  log(`Posted the feed-lint comment on #${number}.`);
  return 'created';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    // Pull requests from forks get a read-only token; the annotations still show the findings.
    console.log(`::warning title=feed-lint::Could not comment on the pull request. ${String(error.message).replace(/\r?\n/g, ' ')}`);
  });
}
