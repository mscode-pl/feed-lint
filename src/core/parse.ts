import sax from 'sax';

export const GOOGLE_NS = 'http://base.google.com/ns/1.0';

export type FeedFormat = 'google' | 'ceneo';

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  cdata: boolean;
  line: number;
  children: XmlNode[];
  // Set on Google feeds for elements in the g: namespace, so they win over plain RSS or Atom elements of the same name.
  google?: boolean;
}

export interface FeedInfo {
  format: FeedFormat;
  root: string;
  rootAttrs: Record<string, string>;
  rootLine: number;
  encoding: string | undefined;
  googleNamespace: string | undefined;
}

export interface ParseError {
  kind: 'xml' | 'format' | 'encoding';
  line: number;
  message: string;
}

export interface ParseResult {
  info: FeedInfo | undefined;
  errors: ParseError[];
  records: number;
  // Ceneo GPSR lists that offers refer to by id.
  responsibleProducers: Set<string>;
  responsiblePersons: Set<string>;
}

export type Chunks = AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;

const RECORD = { google: new Set(['item', 'entry']), ceneo: new Set(['o']) };

function sniffEncoding(head: Uint8Array): { label: string; skip: number } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { label: 'utf-8', skip: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { label: 'utf-16le', skip: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { label: 'utf-16be', skip: 2 };
  const start = new TextDecoder('latin1').decode(head.subarray(0, 512));
  const declared = start.match(/^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/)?.[1];
  return { label: declared ?? 'utf-8', skip: 0 };
}

function decoderFor(label: string): TextDecoder | undefined {
  try {
    return new TextDecoder(label, { fatal: true });
  } catch {
    return undefined;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export async function parseFeed(chunks: Chunks, onRecord: (record: XmlNode, info: FeedInfo, result: ParseResult) => void): Promise<ParseResult> {
  const result: ParseResult = {
    info: undefined,
    errors: [],
    records: 0,
    responsibleProducers: new Set(),
    responsiblePersons: new Set(),
  };
  const parser = sax.parser(true, { xmlns: true, position: true, strictEntities: true } as sax.SAXOptions);
  const stack: XmlNode[] = [];
  let record: XmlNode | undefined;
  let gpsrList: Set<string> | undefined;
  let stopped = false;
  let tagLine = 1;
  let declaredEncoding: string | undefined;

  const fail = (message: string, line = parser.line + 1, kind: ParseError['kind'] = 'xml') => {
    result.errors.push({ kind, line, message });
    stopped = true;
  };

  parser.onerror = (error) => {
    // One broken tag makes sax report follow-on errors; only the first one is real.
    if (stopped) return;
    const message = error.message.split('\n')[0];
    fail(message.charAt(0).toUpperCase() + message.slice(1));
  };

  parser.onprocessinginstruction = (pi) => {
    if (pi.name === 'xml') declaredEncoding = pi.body.match(/encoding\s*=\s*["']([^"']+)["']/)?.[1];
  };

  parser.onopentagstart = () => {
    tagLine = parser.line + 1;
  };

  parser.onopentag = (tag) => {
    if (stopped) return;
    const t = tag as sax.QualifiedTag;
    const attrs: Record<string, string> = {};
    for (const a of Object.values(t.attributes)) attrs[a.name] = a.value;

    if (!result.info) {
      const root = t.local;
      const format: FeedFormat | undefined = root === 'rss' || root === 'feed' ? 'google' : root === 'offers' ? 'ceneo' : undefined;
      if (!format) {
        fail(`Unknown feed format: root element <${t.name}>. Expected <rss> or <feed> (Google Merchant) or <offers> (Ceneo).`, tagLine, 'format');
        return;
      }
      result.info = {
        format,
        root,
        rootAttrs: attrs,
        rootLine: tagLine,
        encoding: declaredEncoding,
        googleNamespace: t.ns?.g,
      };
      stack.push({ name: root, attrs, text: '', cdata: false, line: tagLine, children: [] });
      return;
    }

    const info = result.info;
    // Google fields count with or without the g: prefix, and under a wrongly declared g: namespace.
    const google = info.format === 'google' && (t.uri === GOOGLE_NS || t.prefix === 'g');
    const name = google || (info.format === 'google' && t.prefix === '') ? t.local : t.name;
    const node: XmlNode = { name, attrs, text: '', cdata: false, line: tagLine, children: [] };
    if (google) node.google = true;

    if (record) {
      stack[stack.length - 1].children.push(node);
    } else if (RECORD[info.format].has(name)) {
      record = node;
    } else if (info.format === 'ceneo' && (name === 'responsibleProducers' || name === 'responsiblePersons')) {
      gpsrList = name === 'responsibleProducers' ? result.responsibleProducers : result.responsiblePersons;
    } else if (gpsrList && name === 'p' && attrs.id) {
      gpsrList.add(attrs.id);
    }
    stack.push(node);
  };

  const addText = (text: string, cdata: boolean) => {
    if (stopped || !record) return;
    const node = stack[stack.length - 1];
    node.text += text;
    if (cdata) node.cdata = true;
  };
  parser.ontext = (text) => addText(text, false);
  parser.oncdata = (text) => addText(text, true);

  parser.onclosetag = () => {
    if (stopped) return;
    const node = stack.pop();
    if (node && node === record) {
      result.records++;
      onRecord(record, result.info!, result);
      record = undefined;
    } else if (node && (node.name === 'responsibleProducers' || node.name === 'responsiblePersons')) {
      gpsrList = undefined;
    }
  };

  let decoder: TextDecoder | undefined;
  let head: Uint8Array | undefined;

  const decode = (bytes: Uint8Array, stream: boolean): string | undefined => {
    try {
      return decoder!.decode(bytes, { stream });
    } catch {
      fail(`The bytes do not match the declared encoding (${decoder!.encoding}); the file is probably saved in another encoding.`, parser.line + 1, 'encoding');
      return undefined;
    }
  };

  const start = (bytes: Uint8Array): string | undefined => {
    const { label, skip } = sniffEncoding(bytes);
    decoder = decoderFor(label);
    if (!decoder) {
      fail(`Unsupported encoding "${label}" in the XML declaration.`, 1, 'encoding');
      return undefined;
    }
    return decode(bytes.subarray(skip), true);
  };

  for await (const chunk of chunks) {
    if (stopped) break;
    let text: string | undefined;
    if (typeof chunk === 'string') {
      text = chunk;
    } else if (decoder) {
      text = decode(chunk, true);
    } else {
      // The XML declaration may be split across small chunks (stdin, slow HTTP), so wait for enough of it.
      head = head ? concat(head, chunk) : chunk;
      if (head.length < 512 && !new TextDecoder('latin1').decode(head).includes('?>')) continue;
      text = start(head);
      head = undefined;
    }
    if (text === undefined) break;
    parser.write(text);
  }
  if (!stopped && head) {
    const text = start(head);
    if (text !== undefined) parser.write(text);
  }
  if (!stopped && decoder) {
    const rest = decode(new Uint8Array(), false);
    if (rest) parser.write(rest);
  }
  if (!stopped) parser.close();
  if (!result.info && !result.errors.length) result.errors.push({ kind: 'format', line: 1, message: 'The file is empty or has no root element.' });
  return result;
}
