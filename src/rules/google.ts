import { checkGtin } from '../core/gtin.js';
import type { ParseResult, XmlNode } from '../core/parse.js';
import type { Level, Report, RuleInfo, Sample } from '../core/report.js';
import { htmlTags, isAllCaps, isHttpUrl, promoText, urlExtension } from './text.js';

const SPEC = 'https://support.google.com/merchants/answer/7052112';
const DOCS: Record<string, string> = {
  availability: 'https://support.google.com/merchants/answer/12472827',
  price: 'https://support.google.com/merchants/answer/12471842',
  gtin: 'https://support.google.com/merchants/answer/12473440',
  image_link: 'https://support.google.com/merchants/answer/12472547',
};
const doc = (field: string) => DOCS[field] ?? SPEC;

const REQUIRED = ['id', 'title', 'description', 'link', 'image_link', 'availability', 'price'];
const ALTERNATIVE: Record<string, string> = { title: 'structured_title', description: 'structured_description' };

const LIMITS: Record<string, number> = {
  id: 50,
  title: 150,
  description: 5000,
  brand: 70,
  mpn: 70,
  item_group_id: 50,
  product_type: 750,
  color: 100,
  size: 100,
  mobile_link: 2000,
  image_link: 2000,
  additional_image_link: 2000,
  availability_date: 25,
  sale_price_effective_date: 51,
};

const YES_NO = ['yes', 'no'];
const ENUMS: Record<string, string[]> = {
  availability: ['in_stock', 'out_of_stock', 'preorder', 'backorder'],
  condition: ['new', 'refurbished', 'used'],
  identifier_exists: YES_NO,
  adult: YES_NO,
  is_bundle: YES_NO,
  gender: ['male', 'female', 'unisex'],
  age_group: ['newborn', 'infant', 'toddler', 'kids', 'adult'],
  energy_efficiency_class: ['A+++', 'A++', 'A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G'],
};

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'webp', 'png', 'gif', 'bmp', 'tif', 'tiff']);
const BRAND_PLACEHOLDERS = new Set(['n/a', 'na', 'generic', 'no brand', 'does not exist', 'none', 'brak', 'brak marki', 'bez marki']);
const BAD_COLOR = /^(?:\d+|#?[0-9a-f]{3}|#?[0-9a-f]{6}|\p{L}|multicolou?r|various|n\/?a|see image|wielokolorowy|wielobarwny|różne|inny)$/iu;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export const GOOGLE_RULES: Record<string, RuleInfo> = {};

function rule(id: string, level: Level, title: string, url = SPEC): string {
  GOOGLE_RULES[`google/${id}`] = { level, title, url };
  return `google/${id}`;
}

for (const field of REQUIRED) rule(`missing-${field.replace(/_/g, '-')}`, 'error', `Missing g:${field}`, doc(field));
for (const [field, max] of Object.entries(LIMITS))
  rule(`${field.replace(/_/g, '-')}-length`, 'error', `g:${field} is longer than ${max} characters`, doc(field));
for (const field of Object.keys(ENUMS)) rule(`${field.replace(/_/g, '-')}-value`, 'error', `g:${field} has a value Google does not accept`, doc(field));

const R = {
  duplicateId: rule('duplicate-id', 'error', 'The same g:id is used by more than one product'),
  availabilityDate: rule('availability-date', 'error', 'preorder or backorder without a valid g:availability_date', doc('availability')),
  priceFormat: rule('price-format', 'error', 'Price is not a number with an ISO 4217 currency, e.g. 15.00 PLN', doc('price')),
  pricePrecision: rule('price-precision', 'warning', 'Price has more than 2 decimal places and will be rounded', doc('price')),
  priceZero: rule('price-zero', 'error', 'Price is 0 (only allowed for phones on contract and subscriptions)', doc('price')),
  salePrice: rule('sale-price', 'error', 'g:sale_price is not lower than g:price or uses another currency', doc('price')),
  saleDate: rule('sale-date', 'error', 'g:sale_price_effective_date is not two ISO 8601 dates "start/end" with start before end'),
  gtinFormat: rule('gtin-format', 'error', 'GTIN is not 8, 12, 13 or 14 digits', doc('gtin')),
  gtinChecksum: rule('gtin-checksum', 'error', 'GTIN has a wrong check digit', doc('gtin')),
  gtinRestricted: rule('gtin-restricted', 'error', 'GTIN uses a restricted or coupon prefix (2, 02, 04, 05, 98, 99)', doc('gtin')),
  gtinCount: rule('gtin-count', 'error', 'More than 10 GTINs for one product', doc('gtin')),
  identifiers: rule('identifiers', 'warning', 'No g:gtin, no g:brand with g:mpn and g:identifier_exists is not "no"', doc('gtin')),
  identifierExistsMisused: rule('identifier-exists-misused', 'warning', 'g:identifier_exists is "no" but the product has a valid GTIN', doc('gtin')),
  brandPlaceholder: rule('brand-placeholder', 'error', 'g:brand is a placeholder like "N/A" or "Generic"; leave it empty instead'),
  urlScheme: rule('url-scheme', 'error', 'Link does not start with http:// or https://'),
  http: rule('http', 'warning', 'Link or image uses http:// instead of https://'),
  imageAscii: rule('image-url-ascii', 'error', 'Image URL has spaces or non-ASCII characters; percent-encode them', doc('image_link')),
  imageFormat: rule('image-format', 'warning', 'Image extension is not jpg, png, webp, gif, bmp or tiff', doc('image_link')),
  additionalImages: rule('additional-images-count', 'error', 'More than 10 g:additional_image_link'),
  allCaps: rule('all-caps', 'warning', 'Title or description is written mostly in capital letters'),
  promo: rule('promo-text', 'warning', 'Title has promotional text like "free shipping", "-50%" or "!!"'),
  html: rule('html-in-text', 'warning', 'Title or description has HTML tags; Google expects plain text'),
  color: rule('color-value', 'warning', 'g:color is a number, a code, a single letter or a non-color like "multicolor"'),
};

interface Price {
  amount: number;
  decimals: number;
  currency: string;
}

const PRICE = /^(\d+)(?:\.(\d+))?\s*([A-Za-z]{3})$/;

function parsePrice(value: string): Price | string {
  const m = PRICE.exec(value);
  if (!m) {
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*[A-Za-z]{3}$/.test(value)) return 'remove the thousands separator';
    if (/^\d+,\d+/.test(value)) return 'use a dot as the decimal separator';
    if (/^\d+(?:\.\d+)?$/.test(value)) return 'add a currency code, e.g. PLN';
    return 'expected a format like 15.00 PLN';
  }
  const currency = m[3].toUpperCase();
  if (!CURRENCIES.has(currency)) return `unknown currency ${m[3]}`;
  return { amount: Number(`${m[1]}.${m[2] ?? '0'}`), decimals: m[2]?.length ?? 0, currency };
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function toTime(value: string): number | undefined {
  if (!DATE.test(value)) return undefined;
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(time) ? undefined : time;
}

// Atom keeps its own <id>, <updated> and <link rel="self"> next to the product fields; Google reads <summary> as the description.
export function productFields(item: XmlNode, atom: boolean): Map<string, XmlNode[]> {
  const fields = new Map<string, XmlNode[]>();
  for (const child of item.children) {
    let name = child.name;
    if (atom && !child.google) {
      if (name === 'id' || name === 'updated') continue;
      if (name === 'link' && child.attrs.rel && child.attrs.rel !== 'alternate') continue;
      if (name === 'summary') name = 'description';
    }
    const list = fields.get(name);
    if (list) list.push(child);
    else fields.set(name, [child]);
  }
  for (const list of fields.values()) list.sort((a, b) => Number(Boolean(b.google)) - Number(Boolean(a.google)));
  return fields;
}

export function googleChecker(report: Report, parsed: ParseResult): (item: XmlNode) => void {
  const seen = new Map<string, number>();
  const atom = parsed.info?.root === 'feed';

  return (item) => {
    const fields = productFields(item, atom);
    const node = (name: string) => fields.get(name)?.[0];
    // Atom feeds put the product link in <link href="...">.
    const text = (n: XmlNode | undefined) => (n ? n.text.trim() || n.attrs.href?.trim() || '' : '');
    const value = (name: string) => text(node(name));
    const id = value('id') || undefined;
    const at = (n: XmlNode | undefined, detail?: string): Sample => ({ line: n?.line ?? item.line, id, detail });

    for (const field of REQUIRED) {
      if (!value(field) && !(ALTERNATIVE[field] && value(ALTERNATIVE[field]))) report(`google/missing-${field.replace(/_/g, '-')}`, at(undefined));
    }

    for (const [name, list] of fields) {
      const max = LIMITS[name];
      if (max === undefined) continue;
      for (const n of list) {
        const length = [...text(n)].length;
        if (length > max) report(`google/${name.replace(/_/g, '-')}-length`, at(n, `${length} characters`));
      }
    }

    if (id) {
      const first = seen.get(id);
      if (first !== undefined) report(R.duplicateId, at(node('id'), `first used on line ${first}`));
      else seen.set(id, node('id')!.line);
    }

    for (const [field, allowed] of Object.entries(ENUMS)) {
      const n = node(field);
      const v = text(n);
      if (!v) continue;
      const normalized = field === 'energy_efficiency_class' ? v.toUpperCase() : v.toLowerCase().replace(/ /g, '_');
      if (!allowed.includes(normalized)) report(`google/${field.replace(/_/g, '-')}-value`, at(n, `"${v}", expected ${allowed.join(', ')}`));
    }

    const availability = value('availability').toLowerCase().replace(/ /g, '_');
    if (availability === 'preorder' || availability === 'backorder') {
      const date = value('availability_date');
      if (!date) report(R.availabilityDate, at(node('availability'), `missing for ${availability}`));
      else if (toTime(date) === undefined) report(R.availabilityDate, at(node('availability_date'), `"${date}" is not ISO 8601`));
    }

    let price: Price | undefined;
    for (const field of ['price', 'sale_price']) {
      const n = node(field);
      const v = text(n);
      if (!v) continue;
      const parsed = parsePrice(v);
      if (typeof parsed === 'string') {
        report(R.priceFormat, at(n, `g:${field} "${v}": ${parsed}`));
        continue;
      }
      if (parsed.decimals > 2) report(R.pricePrecision, at(n, `g:${field} "${v}"`));
      if (field === 'price') {
        price = parsed;
        if (parsed.amount === 0) report(R.priceZero, at(n));
      } else if (price && (parsed.currency !== price.currency || parsed.amount >= price.amount)) {
        report(R.salePrice, at(n, `sale ${v}, regular ${value('price')}`));
      }
    }

    const saleDate = value('sale_price_effective_date');
    if (saleDate) {
      const [start, end, ...rest] = saleDate.split('/').map((s) => s.trim());
      const from = toTime(start ?? '');
      const to = toTime(end ?? '');
      if (rest.length || from === undefined || to === undefined || from >= to) report(R.saleDate, at(node('sale_price_effective_date'), `"${saleDate}"`));
    }

    const gtins = (fields.get('gtin') ?? []).flatMap((n) =>
      text(n)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => ({ n, v })),
    );
    if (gtins.length > 10) report(R.gtinCount, at(gtins[10].n, `${gtins.length} GTINs`));
    let validGtin = false;
    for (const { n, v } of gtins) {
      const problem = checkGtin(v);
      if (!problem) validGtin = true;
      else if (problem === 'format') report(R.gtinFormat, at(n, `"${v}"`));
      else if (problem === 'checksum') report(R.gtinChecksum, at(n, `"${v}"`));
      else report(R.gtinRestricted, at(n, `"${v}" (${problem} prefix)`));
    }

    const identifierExists = value('identifier_exists').toLowerCase();
    const condition = value('condition').toLowerCase();
    if (!gtins.length && !(value('brand') && value('mpn')) && identifierExists !== 'no' && (condition === '' || condition === 'new')) {
      report(R.identifiers, at(node('identifier_exists') ?? node('id')));
    }
    if (identifierExists === 'no' && validGtin) report(R.identifierExistsMisused, at(node('identifier_exists')));

    const brand = value('brand');
    if (brand && BRAND_PLACEHOLDERS.has(brand.toLowerCase())) report(R.brandPlaceholder, at(node('brand'), `"${brand}"`));

    for (const field of ['link', 'mobile_link', 'image_link', 'additional_image_link']) {
      for (const n of fields.get(field) ?? []) {
        const url = text(n);
        if (!url) continue;
        if (!isHttpUrl(url)) {
          report(R.urlScheme, at(n, `g:${field} "${url.slice(0, 80)}"`));
          continue;
        }
        if ((field === 'link' || field === 'image_link') && /^http:/i.test(url)) report(R.http, at(n, `g:${field}`));
        if (field.includes('image')) {
          if (/[^\x21-\x7e]/.test(url)) report(R.imageAscii, at(n, url.slice(0, 120)));
          const ext = urlExtension(url);
          if (ext && !IMAGE_EXTENSIONS.has(ext)) report(R.imageFormat, at(n, `.${ext}`));
        }
      }
    }
    const additional = fields.get('additional_image_link') ?? [];
    if (additional.length > 10) report(R.additionalImages, at(additional[10], `${additional.length} images`));

    for (const field of ['title', 'description']) {
      const n = node(field);
      const v = text(n);
      if (!v) continue;
      if (isAllCaps(v)) report(R.allCaps, at(n, `g:${field}`));
      const tags = htmlTags(v);
      if (tags.length) report(R.html, at(n, `g:${field}: <${[...new Set(tags)].slice(0, 5).join('>, <')}>`));
      if (field === 'title') {
        const promo = promoText(v);
        if (promo) report(R.promo, at(n, `"${promo}"`));
      }
    }

    const color = value('color');
    if (color && color.split('/').some((c) => BAD_COLOR.test(c.trim()))) report(R.color, at(node('color'), `"${color}"`));
  };
}
