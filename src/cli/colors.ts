const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  underline: [4, 24],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
} as const;

export type Style = keyof typeof CODES;
export type Paint = (style: Style, text: string) => string;

export function colorSupported() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

export function painter(enabled = colorSupported()): Paint {
  if (!enabled) return (_, text) => text;
  return (style, text) => {
    const [open, close] = CODES[style];
    return `\u001b[${open}m${text}\u001b[${close}m`;
  };
}
