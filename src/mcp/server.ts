import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { callTool, ToolInputError, TOOLS } from './tools.js';

// Newest first. The tools use nothing that differs between these versions.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Id = string | number | null;

interface JsonRpcError {
  code: number;
  message: string;
}

export type Response =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: JsonRpcError };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion:
          typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'feed-lint', title: 'feed-lint', version: packageVersion() },
        instructions:
          'Checks Google Merchant and Ceneo XML product feeds. Call lint_feed with a file path or URL, fix errors first (they get products rejected), then warnings. Use explain_rule for the fix and the source in the specification.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      if (typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, '"name" must be a string.');
      const args = params.arguments ?? {};
      if (!isObject(args)) throw new RpcError(INVALID_PARAMS, '"arguments" must be an object.');
      try {
        return await callTool(params.name, args);
      } catch (error) {
        if (error instanceof ToolInputError) throw new RpcError(INVALID_PARAMS, error.message);
        throw error;
      }
    }
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

async function handleOne(message: unknown): Promise<Response | undefined> {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    const id = isObject(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    // Responses from the client (to requests this server never sends) are ignored.
    if (isObject(message) && ('result' in message || 'error' in message)) return undefined;
    return { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid request.' } };
  }
  const isNotification = !('id' in message);
  const id = (message.id ?? null) as Id;
  const params = isObject(message.params) ? message.params : {};

  try {
    const result = await dispatch(message.method, params);
    return isNotification ? undefined : { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (isNotification) return undefined;
    const code = error instanceof RpcError ? error.code : -32603;
    const text = error instanceof Error ? error.message : String(error);
    return { jsonrpc: '2.0', id, error: { code, message: text } };
  }
}

export async function handle(message: unknown): Promise<Response | Response[] | undefined> {
  if (!Array.isArray(message)) return handleOne(message);
  if (!message.length) {
    return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Empty batch.' } };
  }
  const responses = (await Promise.all(message.map(handleOne))).filter((r) => r !== undefined);
  return responses.length ? responses : undefined;
}

export async function handleLine(line: string): Promise<Response | Response[] | undefined> {
  if (!line.trim()) return undefined;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error.' } };
  }
  return handle(message);
}

export function serve(
  input: NodeJS.ReadableStream = process.stdin,
  output: Pick<NodeJS.WritableStream, 'write'> = process.stdout,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Infinity });

  lines.on('line', (line) => {
    const task = handleLine(line).then((response) => {
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });

  return new Promise((resolve) => {
    lines.on('close', () => {
      void Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}
