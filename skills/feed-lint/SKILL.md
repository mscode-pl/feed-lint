---
name: feed-lint
description: Check Google Merchant (Google Shopping, Meta catalog) and Ceneo XML product feeds with feed-lint and fix the code that generates them. Use when the user asks why products are disapproved in Merchant Center or hidden on Ceneo, wants a product feed reviewed, or is writing or changing a feed export.
---

# feed-lint review

feed-lint checks a product feed against the Google Merchant product data specification and the Ceneo XML guide and groups the findings by rule, with line numbers and product ids. Your job is to run it, find the code that produced each problem and fix the export, not the generated XML.

## 1. Find the feed

- A URL the user gives, or the shop's public feed URL (`/feed/google.xml`, `/ceneo.xml` and similar).
- A file the export writes (look for routes or jobs that build `<rss` with `xmlns:g="http://base.google.com/ns/1.0"` or `<offers`).
- If the feed is built on request, run the export or request the route locally and save the output.

## 2. Run the linter

If the `lint_feed` and `explain_rule` tools from the feed-lint MCP server are available, use them instead of the command below.

```bash
npx -y @mscode-pl/feed-lint <file or URL> --format json
```

- Exit code 1 means errors were found, which is expected during a review. Exit code 2 means the feed could not be read.
- Add `--check-urls` only when the user asks about broken links or images; it sends requests to the shop.
- The JSON is an array with one entry per feed: `{ feed, format, records, errors, warnings, results: [{ rule, level, title, url, count, samples: [{ line, id, detail }] }] }`.

## 3. Triage

- **Errors** get a product or the whole feed rejected. Fix them first, largest `count` first: one export bug usually explains thousands of hits.
- **Warnings** limit how products are shown or break the specification's content rules (all caps, promotional text). Fix the cheap ones and say which you left.
- `xml/parse` means nothing else was checked past that line. Fix it before anything else.
- `google/identifiers` on own-brand or handmade products is fixed by sending `g:identifier_exists` = `no`, not by inventing GTINs. Never generate or guess a GTIN or EAN.

## 4. Fix the export

For each rule, open a sample product (`line`, `id`) in the feed, then the code that writes that field. Typical causes:

| Rule | Usual cause in the export |
| --- | --- |
| `google/duplicate-id`, `ceneo/duplicate-id` | A join that repeats a product per category, image or warehouse; ids built from the product instead of the variant |
| `google/price-format`, `ceneo/price-format` | Locale formatting (`number_format`, `toLocaleString`) instead of a fixed dot and 2 decimals |
| `google/gtin-checksum`, `ceneo/ean` | Internal SKUs or supplier codes written into the GTIN field |
| `google/color-value` | Internal color ids instead of color names |
| `google/html-in-text`, `ceneo/desc-cdata` | Rich-text descriptions written without stripping tags, or without CDATA for Ceneo |
| `ceneo/avail-value` | Stock counts or days written as `avail` instead of the Ceneo codes 1, 3, 7, 14, 90, 99, 110 |

`explain_rule` (or the `url` of each result) gives the fix and the paragraph of the specification.

## 5. Verify

Run feed-lint again on the new output and report the error and warning counts before and after.
