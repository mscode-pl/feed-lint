const FIXES: Record<string, string> = {
  'xml/parse': 'Fix the XML at the reported line. Usually an unescaped & or < in a value: escape it (&amp;, &lt;) or wrap the value in <![CDATA[...]]>.',
  'xml/format-unknown': 'Google feeds start with <rss> (with xmlns:g="http://base.google.com/ns/1.0") or <feed>; Ceneo feeds start with <offers>.',
  'google/duplicate-id': 'Every product needs its own g:id. Check the export for joins that repeat a product (for example one row per category or warehouse) and use the variant SKU as the id.',
  'google/identifiers':
    'Send g:gtin (EAN) when the product has one. Without a GTIN send g:brand and g:mpn. For own-brand, handmade or custom products with neither, set g:identifier_exists to "no".',
  'google/identifier-exists-misused': 'Remove g:identifier_exists or set it to "yes"; the product has a valid GTIN.',
  'google/gtin-checksum': 'The last digit of the GTIN does not match. Copy the GTIN from the packaging or the supplier; never generate one.',
  'google/gtin-format': 'Use 8, 12, 13 or 14 digits. Convert ISBN-10 to ISBN-13 and UPC-E to UPC-A. Leave g:gtin out when there is none.',
  'google/gtin-restricted': 'Prefixes 2, 02 and 04 are for in-store codes and 05, 98, 99 for coupons. Use the manufacturer GTIN or leave g:gtin out.',
  'google/price-format': 'Write the price as a number with a dot and an ISO 4217 code: 1299.99 PLN. No thousands separators, no "zł".',
  'google/sale-price': 'g:sale_price must be lower than g:price and use the same currency. Drop g:sale_price when there is no sale.',
  'google/availability-value': 'Use in_stock, out_of_stock, preorder or backorder.',
  'google/brand-placeholder': 'Leave g:brand empty when the product has no brand; placeholders get the product disapproved.',
  'google/color-value': 'Use color names in the language of the feed, e.g. "Czarny" or "Czarny/Biały" for several. Map internal color codes to names in the export.',
  'google/all-caps': 'Write titles and descriptions in sentence case; all caps reads as spam and may be disapproved.',
  'google/promo-text': 'Move "free shipping", discounts and "!!" out of the title. Use g:sale_price and shipping settings instead.',
  'google/html-in-text': 'Strip HTML tags from g:title and g:description; Google shows them as plain text.',
  'google/http': 'Serve product pages and images over https.',
  'google/image-url-ascii': 'Percent-encode spaces and non-ASCII characters in image URLs (encodeURI does this).',
  'ceneo/avail-value': 'Use 1 (ships within 24 h), 3, 7, 14, 90 (made to order), 99 (check in store) or 110 (pre-order).',
  'ceneo/price-format': 'Write the price as a number with a dot: 1299.99. No currency, no thousands separators.',
  'ceneo/cat-generic': 'Send the full category path from your shop, e.g. "Dom i ogród/Ogród/Pompy". Do not use temporary categories like "Promocja".',
  'ceneo/desc-cdata': 'Wrap the description in <![CDATA[ ... ]]> so Ceneo reads the HTML as text.',
  'ceneo/desc-html': 'Keep to p, h2, h3, br, ol, ul, li, i, b, strong, em. Remove links, div, span, tables and inline styles.',
  'ceneo/ean': 'Send the 8 or 13 digit EAN from the packaging as <a name="Kod EAN">. Remove the attribute when there is no EAN.',
  'ceneo/brand': 'Add <a name="Marka">Brand</a> (or "Producent") to <attrs>; Ceneo uses it to match the offer to a product.',
  'ceneo/gpsr-reference': 'List the producer or person in <responsibleProducers> or <responsiblePersons> as <p id="..."> before the offers, and use that id in the attribute.',
  'url/unreachable': 'Fix or remove products whose page or image does not load; Google and Ceneo reject them.',
  'url/redirect': 'Put the final URL in the feed. Redirects slow crawling and break if the target changes.',
};

export function fixFor(rule: string): string {
  if (FIXES[rule]) return FIXES[rule];
  if (/\/missing-/.test(rule)) return 'Add the missing field to every product; products without it are rejected.';
  if (/-length$/.test(rule)) return 'Shorten the value to the limit; longer values are cut or rejected.';
  if (/-value$/.test(rule)) return 'Use one of the values listed in the rule title or the linked specification.';
  return 'See the linked specification for the accepted format.';
}
