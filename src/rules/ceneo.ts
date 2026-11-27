import { checkGtin, normalizeGtin } from '../core/gtin.js';
import type { FeedInfo, ParseResult, XmlNode } from '../core/parse.js';
import type { Level, Report, RuleInfo, Sample } from '../core/report.js';
import { htmlTags, isHttpUrl, promoText } from './text.js';

const GUIDE = 'https://www.ceneo.pl/poradniki/Instrukcja-tworzenia-pliku-XML';

const ENCODINGS = new Set(['utf-8', 'utf8', 'iso-8859-2', 'windows-1250']);
const AVAIL = ['1', '3', '7', '14', '90', '99', '110'];
const DESC_TAGS = new Set(['p', 'h2', 'h3', 'br', 'ol', 'ul', 'li', 'i', 'b', 'strong', 'em']);
const GENERIC_CATEGORIES = new Set(
  ['wyprzedaż', 'promocja', 'nowości', 'tymczasowa', 'księgarnia', 'zabawki', 'książki i ebooki', 'leki i suplementy', 'inne', 'pozostałe'].map((c) => c.toLowerCase()),
);
const ELEMENTS = ['cat', 'name', 'imgs', 'desc', 'attrs'];
const OFFER_ATTRS = ['id', 'url', 'price', 'avail'];

const LIMITS: Record<string, number> = { id: 100, url: 1000, cat: 255, name: 150, desc: 100_000, fileVersion: 255 };

export const CENEO_RULES: Record<string, RuleInfo> = {};

function rule(id: string, level: Level, title: string): string {
  CENEO_RULES[`ceneo/${id}`] = { level, title, url: GUIDE };
  return `ceneo/${id}`;
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

for (const a of OFFER_ATTRS) rule(`missing-${a}`, 'error', `Offer <o> has no ${a} attribute`);
for (const e of ELEMENTS) rule(`missing-${e}`, 'error', `Offer has no <${e}>`);
for (const [field, max] of Object.entries(LIMITS)) rule(`${kebab(field)}-length`, 'error', `${field} is longer than ${max.toLocaleString('en')} characters`);

const R = {
  encoding: rule('encoding', 'error', 'Encoding is not UTF-8, ISO-8859-2 or Windows-1250'),
  encodingMissing: rule('encoding-missing', 'warning', 'The XML declaration does not state the encoding'),
  version: rule('version', 'warning', 'Root <offers> has no version="1"'),
  duplicateId: rule('duplicate-id', 'error', 'The same offer id is used more than once'),
  urlScheme: rule('url-scheme', 'error', 'Offer url does not start with http:// or https://'),
  priceFormat: rule('price-format', 'error', 'price is not a number with a dot as the decimal separator, e.g. 12.99'),
  priceZero: rule('price-zero', 'warning', 'price is 0 in a full offer (in incremental mode price 0 hides the offer)'),
  avail: rule('avail-value', 'error', 'avail is not one of 1, 3, 7, 14, 90, 99, 110'),
  stock: rule('stock', 'error', 'stock is not a whole number of 0 or more'),
  weight: rule('weight', 'error', 'weight is not a number in kilograms with a dot, e.g. 0.75'),
  basket: rule('basket', 'error', 'basket is not 0 or 1'),
  catGeneric: rule('cat-generic', 'warning', 'Category is temporary or too general (e.g. "Promocja", "Nowości") or has no path'),
  namePromo: rule('name-promo', 'warning', 'Name has commercial additions like "darmowa dostawa" or "-50%"'),
  mainImage: rule('main-image', 'error', 'No <main url="..."> image in <imgs>'),
  imagesCount: rule('images-count', 'error', 'More than 20 images'),
  imageUrl: rule('image-url', 'error', 'Image URL is longer than 2048 characters or not http(s)'),
  descHtml: rule('desc-html', 'warning', 'Description uses HTML tags Ceneo does not allow (only p, h2, h3, br, ol, ul, li, i, b, strong, em)'),
  descCdata: rule('desc-cdata', 'warning', 'Description HTML is not wrapped in CDATA, so it is parsed as XML elements'),
  attrsCount: rule('attrs-count', 'error', 'More than 500 attributes'),
  attrDuplicate: rule('attr-duplicate', 'warning', 'The same attribute name appears twice in one offer'),
  ean: rule('ean', 'error', '"Kod EAN" is not 8 or 13 digits or has a wrong check digit'),
  isbn: rule('isbn', 'error', '"Kod ISBN" is not 13 digits or has a wrong check digit'),
  drugCode: rule('drug-code', 'error', '"Kod leku" is not 7 digits'),
  brand: rule('brand', 'warning', 'No "Marka" or "Producent" attribute'),
  energyClass: rule('energy-class', 'error', '"Klasa energetyczna" is not A to G (or A+++ to A+ on the older scale)'),
  ceMark: rule('ce-mark', 'error', '"Unijny znak CE" is not 0 or 1'),
  ceYear: rule('ce-year', 'warning', '"Unijny znak CE" is 1 but "Rok nadania znaku CE" is missing'),
  gpsr: rule('gpsr-reference', 'error', 'GPSR attribute points to an id missing from <responsibleProducers> or <responsiblePersons>'),
};

export function ceneoFileChecks(info: FeedInfo, report: Report): void {
  const at = (detail?: string): Sample => ({ line: info.rootLine, detail });
  if (!info.encoding) report(R.encodingMissing, { line: 1 });
  else if (!ENCODINGS.has(info.encoding.toLowerCase())) report(R.encoding, { line: 1, detail: info.encoding });
  if (info.rootAttrs.version !== '1') report(R.version, at(info.rootAttrs.version ? `version="${info.rootAttrs.version}"` : undefined));
  const fileVersion = info.rootAttrs.fileVersion;
  if (fileVersion && [...fileVersion].length > LIMITS.fileVersion) report('ceneo/file-version-length', at(`${[...fileVersion].length} characters`));
}

const NUMBER = /^\d+(?:\.\d+)?$/;

export function ceneoChecker(report: Report, parsed: ParseResult): ((offer: XmlNode) => void) & { end: () => void } {
  const seen = new Map<string, number>();
  const pending: { sample: Sample; kind: 'producer' | 'person'; id: string }[] = [];

  // GPSR ids are resolved after the whole file, so lists placed after the offers get a precise message.
  const end = () => {
    for (const { sample, kind, id } of pending) {
      const list = kind === 'producer' ? parsed.responsibleProducers : parsed.responsiblePersons;
      const where = list.has(id) ? 'is declared after the offers; move the list before the first <o>' : 'is not declared';
      report(R.gpsr, { ...sample, detail: `${kind} "${id}" ${where}` });
    }
  };

  const check = (offer: XmlNode) => {
    const a = offer.attrs;
    const id = a.id?.trim() || undefined;
    const update = a.update === '1';
    const at = (n: XmlNode | undefined, detail?: string): Sample => ({ line: n?.line ?? offer.line, id, detail });
    const child = (name: string) => offer.children.find((c) => c.name === name);

    for (const attr of update ? ['id'] : OFFER_ATTRS) if (!a[attr]?.trim()) report(`ceneo/missing-${attr}`, at(undefined));
    if (!update) for (const e of ELEMENTS) if (!child(e)) report(`ceneo/missing-${e}`, at(undefined));

    if (id) {
      if ([...id].length > LIMITS.id) report('ceneo/id-length', at(undefined, `${[...id].length} characters`));
      const first = seen.get(id);
      if (first !== undefined) report(R.duplicateId, at(undefined, `first used on line ${first}`));
      else seen.set(id, offer.line);
    }

    if (a.url) {
      if ([...a.url].length > LIMITS.url) report('ceneo/url-length', at(undefined, `${[...a.url].length} characters`));
      if (!isHttpUrl(a.url.trim())) report(R.urlScheme, at(undefined, a.url.slice(0, 80)));
    }

    if (a.price !== undefined) {
      const price = a.price.trim();
      if (!NUMBER.test(price)) report(R.priceFormat, at(undefined, `"${a.price}"`));
      else if (Number(price) === 0 && !update) report(R.priceZero, at(undefined));
    }
    if (a.avail !== undefined && !AVAIL.includes(a.avail.trim())) report(R.avail, at(undefined, `"${a.avail}"`));
    if (a.stock !== undefined && !/^\d+$/.test(a.stock.trim())) report(R.stock, at(undefined, `"${a.stock}"`));
    if (a.weight !== undefined && !NUMBER.test(a.weight.trim())) report(R.weight, at(undefined, `"${a.weight}"`));
    if (a.basket !== undefined && !['0', '1'].includes(a.basket.trim())) report(R.basket, at(undefined, `"${a.basket}"`));

    const cat = child('cat');
    if (cat) {
      const value = cat.text.trim();
      if ([...value].length > LIMITS.cat) report('ceneo/cat-length', at(cat, `${[...value].length} characters`));
      const leaf = value.split('/').pop()?.trim().toLowerCase() ?? '';
      if (value && (!value.includes('/') || GENERIC_CATEGORIES.has(leaf))) report(R.catGeneric, at(cat, `"${value.slice(0, 80)}"`));
    }

    const name = child('name');
    if (name) {
      const value = name.text.trim();
      if ([...value].length > LIMITS.name) report('ceneo/name-length', at(name, `${[...value].length} characters`));
      const promo = promoText(value);
      if (promo) report(R.namePromo, at(name, `"${promo}"`));
    }

    const imgs = child('imgs');
    if (imgs) {
      const images = imgs.children.filter((c) => c.name === 'main' || c.name === 'i');
      if (!images.some((c) => c.name === 'main' && c.attrs.url?.trim())) report(R.mainImage, at(imgs));
      if (images.length > 20) report(R.imagesCount, at(imgs, `${images.length} images`));
      for (const img of images) {
        const url = img.attrs.url?.trim();
        if (url && (url.length > 2048 || !isHttpUrl(url))) report(R.imageUrl, at(img, url.slice(0, 80)));
      }
    }

    const desc = child('desc');
    if (desc) {
      if ([...desc.text].length > LIMITS.desc) report('ceneo/desc-length', at(desc, `${[...desc.text].length} characters`));
      if (desc.children.length) report(R.descCdata, at(desc, `<${desc.children[0].name}>`));
      const tags = [...htmlTags(desc.text), ...flatten(desc.children).map((c) => c.name.toLowerCase())];
      const bad = [...new Set(tags.filter((t) => !DESC_TAGS.has(t)))];
      if (bad.length) report(R.descHtml, at(desc, `<${bad.slice(0, 5).join('>, <')}>`));
    }

    const attrs = child('attrs');
    if (attrs) {
      const list = attrs.children.filter((c) => c.name === 'a');
      if (list.length > 500) report(R.attrsCount, at(attrs, `${list.length} attributes`));
      const values = new Map<string, { n: XmlNode; v: string }>();
      for (const n of list) {
        const key = (n.attrs.name ?? '').trim().toLowerCase().replace(/_/g, ' ');
        if (!key) continue;
        if (values.has(key)) report(R.attrDuplicate, at(n, `"${n.attrs.name}"`));
        else values.set(key, { n, v: n.text.trim() });
      }
      const get = (...names: string[]) => names.map((k) => values.get(k)).find((x) => x && x.v);

      const ean = get('kod ean', 'ean');
      if (ean) {
        for (const v of ean.v.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
          if (checkGtin(v, [8, 13]) === 'format' || checkGtin(v, [8, 13]) === 'checksum') report(R.ean, at(ean.n, `"${v}"`));
        }
      }
      const isbn = get('kod isbn', 'isbn');
      if (isbn) {
        const digits = normalizeGtin(isbn.v);
        if (!/^\d{13}$/.test(digits) || checkGtin(digits, [13]) === 'checksum') report(R.isbn, at(isbn.n, `"${isbn.v}"`));
      }
      const drug = get('kod leku');
      if (drug && !/^\d{7}$/.test(drug.v)) report(R.drugCode, at(drug.n, `"${drug.v}"`));
      if (!update && !get('marka', 'producent')) report(R.brand, at(attrs));
      const energy = get('klasa energetyczna');
      // Ovens and range hoods still carry the older A+++ to D label legally.
      if (energy && !/^(?:[A-G]|A\+{1,3})$/i.test(energy.v)) report(R.energyClass, at(energy.n, `"${energy.v}"`));
      const ce = get('unijny znak ce');
      if (ce) {
        if (ce.v !== '0' && ce.v !== '1') report(R.ceMark, at(ce.n, `"${ce.v}"`));
        else if (ce.v === '1' && !get('rok nadania znaku ce')) report(R.ceYear, at(ce.n));
      }
      const producer = get('producent odpowiedzialny');
      if (producer && !parsed.responsibleProducers.has(producer.v)) pending.push({ sample: at(producer.n), kind: 'producer', id: producer.v });
      const person = get('podmiot odpowiedzialny');
      if (person && !parsed.responsiblePersons.has(person.v)) pending.push({ sample: at(person.n), kind: 'person', id: person.v });
    } else if (!update) {
      report(R.brand, at(undefined));
    }
  };

  return Object.assign(check, { end });
}

function flatten(nodes: XmlNode[]): XmlNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}
