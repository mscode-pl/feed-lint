const PROMO =
  /\b(?:(?:free shipping|free delivery|best price|on sale|darmow[aey] (?:dostaw|wysy)|promocj|wyprzeda|najtaniej)\p{L}*|gratis(?!\p{L})|super okazj\p{L}*)|(?:^|\s)-\d{1,2}\s?%|!{2,}/iu;

export function promoText(text: string): string | undefined {
  return PROMO.exec(text)?.[0];
}

export function isAllCaps(text: string): boolean {
  const upper = text.match(/\p{Lu}/gu)?.length ?? 0;
  const lower = text.match(/\p{Ll}/gu)?.length ?? 0;
  return upper + lower >= 10 && upper / (upper + lower) > 0.7;
}

export function htmlTags(text: string): string[] {
  return [...text.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)].map((m) => m[1].toLowerCase());
}

export const isHttpUrl = (url: string) => /^https?:\/\/[^\s/]+/i.test(url);

export function urlExtension(url: string): string | undefined {
  try {
    return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase();
  } catch {
    return undefined;
  }
}
