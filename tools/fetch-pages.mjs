#!/usr/bin/env node
/**
 * Fetch the provider pages this project cites, and archive their text under research/pages/ — NOT part
 * of the CLI.
 *
 * WHY: policy pages change, and a citation that cannot be re-read is not evidence. Saving the stripped
 * text makes later greps cheap, offline and repeatable, and keeps the checkedAt date meaningful.
 *
 * Usage: node tools/fetch-pages.mjs [slug=url ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'research', 'pages');

/** Default set: the login-free / anonymous candidates this project is evaluating. */
const DEFAULT_PAGES = [
  ['edgeone-cli', 'https://pages.edgeone.ai/zh/document/edgeone-cli'],
  ['edgeone-login-free', 'https://pages.edgeone.ai/zh/document/quick-launch-via-login-free-deployment-in-workbuddy'],
  ['edgeone-limits', 'https://pages.edgeone.ai/zh/document/limits-and-quotas'],
  ['previewship-facts', 'https://previewship.com/facts'],
  ['previewship-limits', 'https://previewship.com/docs/pricing-limits'],
  ['tiiny-developers', 'https://www.tiiny.host/for/developers/'],
  ['staticrun-pricing', 'https://static.run/pricing'],
  ['neocities-api', 'https://neocities.org/api'],
  ['surge-cli', 'https://surge.sh/docs/cli/']
];

const pages = process.argv.slice(2).length
  ? process.argv.slice(2).map((entry) => {
      const at = entry.indexOf('=');
      return [entry.slice(0, at), entry.slice(at + 1)];
    })
  : DEFAULT_PAGES;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);

for (const [slug, url] of pages) {
  let status = 0;
  let text = '';
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; vpublish-page-archive)', accept: 'text/html' },
      signal: AbortSignal.timeout(25000)
    });
    status = response.status;
    text = stripHtml(await response.text());
  } catch (cause) {
    process.stdout.write(`${slug.padEnd(22)} FETCH FAILED: ${cause.message}\n`);
    continue;
  }
  const file = path.join(outDir, `${slug}.txt`);
  const header = `source: ${url}\nfetched: ${new Date().toISOString()}\nhttpStatus: ${status}\n\n`;
  fs.writeFileSync(file, header + text + '\n', 'utf8');
  process.stdout.write(`${slug.padEnd(22)} ${String(status).padEnd(4)} ${String(text.length).padStart(6)} chars -> research/pages/${slug}.txt\n`);
}

process.stdout.write(`\narchived ${pages.length} page(s) on ${stamp}\n`);
