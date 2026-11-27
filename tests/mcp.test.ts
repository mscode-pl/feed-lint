import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { handle, handleLine, PROTOCOL_VERSIONS, serve } from '../src/mcp/server.js';

const BAD = readFileSync(new URL('./fixtures/google-bad.xml', import.meta.url), 'utf8');

async function call(name: string, args: Record<string, unknown>) {
  const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (!response || Array.isArray(response)) throw new Error('expected a single response');
  return response;
}

async function callText(name: string, args: Record<string, unknown>) {
  const response = await call(name, args);
  if (!('result' in response)) throw new Error(response.error.message);
  const result = response.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0].text, isError: result.isError ?? false };
}

describe('mcp server', () => {
  it('answers initialize with the requested protocol version and tool capability', async () => {
    const response = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    expect(response).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'feed-lint' } },
    });
  });

  it('falls back to its newest protocol version for an unknown one', async () => {
    const response = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(response).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSIONS[0] } });
  });

  it('lists both tools with input schemas', async () => {
    const response = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (response as { result: { tools: { name: string; inputSchema: object }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(['lint_feed', 'explain_rule']);
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object' });
  });

  it('lints XML passed inline', async () => {
    const { text, isError } = await callText('lint_feed', { xml: BAD });
    expect(isError).toBe(false);
    expect(text).toContain('google/duplicate-id');
    expect(text).toContain('https://support.google.com/merchants/answer/7052112');
  });

  it('lints a file from a path', async () => {
    const { text } = await callText('lint_feed', { path: 'tests/fixtures/ceneo-good.xml' });
    expect(text).toContain('Ceneo, 3 offers');
    expect(text).toContain('no issues');
  });

  it('returns tool errors the agent can act on', async () => {
    expect(await callText('lint_feed', { xml: BAD, path: 'x.xml' })).toMatchObject({ isError: true });
    expect(await callText('lint_feed', { path: 'missing.xml' })).toMatchObject({ isError: true, text: expect.stringContaining('file not found') });
    expect(await callText('lint_feed', { url: 'ftp://x' })).toMatchObject({ isError: true });
    expect(await callText('lint_feed', { xml: BAD, ignore: ['nope'] })).toMatchObject({ isError: true, text: expect.stringContaining('Unknown rule') });
    expect(await callText('lint_feed', {})).toMatchObject({ isError: true, text: expect.stringContaining('feed-lint.config.json') });
  });

  it('explains a rule with its fix and source', async () => {
    const { text } = await callText('explain_rule', { rule: 'google/identifiers' });
    expect(text).toContain('identifier_exists to "no"');
    expect(text).toContain('Warning');
    expect(text).toContain('Source: https://support.google.com/');
  });

  it('gives a generic fix for rules without a specific one', async () => {
    expect((await callText('explain_rule', { rule: 'ceneo/name-length' })).text).toContain('Shorten');
  });

  it('suggests similar rules for an unknown one', async () => {
    const { text, isError } = await callText('explain_rule', { rule: 'google/gtin' });
    expect(isError).toBe(true);
    expect(text).toContain('google/gtin-checksum');
  });

  it('reports protocol errors as JSON-RPC errors', async () => {
    expect(await call('no_such_tool', {})).toMatchObject({ error: { code: -32602 } });
    expect(await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
    expect(await handleLine('{not json')).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await handle({ id: 4 })).toMatchObject({ id: 4, error: { code: -32600 } });
  });

  it('serves newline-delimited JSON over streams', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => (written += chunk));

    const done = serve(input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    await done;

    const lines = written.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id).sort()).toEqual([1, 2]);
  });
});
