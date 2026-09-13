#!/usr/bin/env node
/**
 * Re-check the plan/policy claims this project makes about hosting providers — NOT part of the CLI.
 *
 * WHY THIS EXISTS: a provider's free tier, lifetime and limits change without notice, and a registry
 * entry that was true in September is not evidence in December. This tool fetches the primary source
 * for each claim, extracts the sentence fragments that actually appear on the page, and writes a
 * dated record. It verifies *claims*, not products: a fragment proves the page says something like
 * the claim, not that the platform behaves that way.
 *
 * Output (committed, so the record is reviewable):
 *   research/policy-checks.json      machine-readable, one entry per claim with source + checkedAt
 *
 * Usage: node tools/check-policies.mjs [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'research', 'policy-checks.json');

/**
 * Every entry names the platform, the claim as this project would repeat it, the primary source, and
 * the patterns that must appear for the claim to count as confirmed *here*. A claim whose patterns
 * do not match stays unconfirmed — that is the point of the tool.
 */
const CHECKS = [
  {
    id: 'edgeone-makers-limits',
    platform: 'EdgeOne Makers',
    claim: 'public-beta free tier; 40 projects, 500 builds/month, 25 MB per file',
    url: 'https://pages.edgeone.ai/zh/document/limits-and-quotas',
    patterns: ['40\\s*(个|projects)', '500\\s*(次|builds)', '25\\s*MB']
  },
  {
    id: 'edgeone-cli-surface',
    platform: 'EdgeOne Makers',
    claim: 'the CLI is `edgeone makers` (with a legacy `edgeone pages` path) and offers China/Global site selection',
    url: 'https://pages.edgeone.ai/zh/document/edgeone-cli',
    patterns: ['edgeone\\s+(makers|pages)', '(china|global|中国大陆|全球)']
  },
  {
    id: 'edgeone-anonymous-claim-window',
    platform: 'EdgeOne Makers',
    claim: 'a login-free deployment can be claimed within 60 minutes',
    url: 'https://pages.edgeone.ai/zh/document/quick-launch-via-login-free-deployment-in-workbuddy',
    patterns: ['60\\s*(分钟|min)']
  },
  {
    id: 'esa-free-plan',
    platform: 'Aliyun ESA',
    claim: 'a zero-yuan free plan exists, with account and usage conditions and no SLA',
    url: 'https://help.aliyun.com/zh/edge-security-acceleration/esa/product-overview/free-plan',
    patterns: ['(0\\s*元|免费)', '(SLA|限制|条件)']
  },
  {
    id: 'esa-cli-pages-token',
    platform: 'Aliyun ESA',
    claim: 'the public test domain needs a token that is valid for 60 minutes; a custom domain must be onboarded first; RAM users are recommended',
    url: 'https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/create-pages-by-cli',
    patterns: ['60\\s*(分钟|min)', 'token', 'RAM', '自定义域名']
  },
  {
    id: 'cloudflare-workers-static-assets',
    platform: 'Cloudflare Workers',
    claim: 'static asset requests are free and unlimited, while Worker invocations follow the compute plan',
    url: 'https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/',
    patterns: ['(free|免费)', '(unlimited|不限)']
  },
  {
    id: 'netlify-credits',
    platform: 'Netlify',
    claim: 'the free plan is 300 credits per month and a production deploy costs 15 credits',
    url: 'https://www.netlify.com/pricing/',
    patterns: ['credit', '300', '15\\s*credit']
  },
  {
    id: 'surge-plans',
    platform: 'Surge',
    claim: 'the free plan covers custom domains and automatic SSL',
    url: 'https://surge.sh/docs/platform/plans',
    patterns: ['free', 'custom domain', '(SSL|HTTPS)']
  },
  {
    id: 'ship-page-lifetime',
    platform: 'ship.page',
    claim: 'documented lifetime differs by page (free plan vs anonymous agent drops) — deploy from the response, not a constant',
    url: 'https://ship.page/docs/limits',
    patterns: ['(7|30)\\s*days?', 'free']
  }
];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; vpublish-policy-check)', accept: 'text/html' },
      signal: AbortSignal.timeout(25000)
    });
    return { status: response.status, text: stripHtml(await response.text()) };
  } catch (cause) {
    return { status: 0, text: '', error: cause.message };
  }
}

const checkedAt = new Date().toISOString();
const results = [];

for (const check of CHECKS) {
  const page = await fetchText(check.url);
  const evidence = check.patterns.map((pattern) => {
    let match = null;
    try {
      match = new RegExp(pattern, 'i').exec(page.text);
    } catch {
      match = null;
    }
    return { pattern, found: Boolean(match), fragment: match ? match[0].trim().slice(0, 200) : null };
  });
  const confirmed = page.status === 200 && evidence.every((entry) => entry.found);
  const entry = {
    id: check.id,
    platform: check.platform,
    claim: check.claim,
    source: check.url,
    checkedAt,
    httpStatus: page.status,
    ...(page.error ? { error: page.error } : {}),
    // 'confirmed' means every required fragment was on the page today. It does not mean the platform
    // behaves as documented, and it is not a recommendation to enable anything by default.
    status: confirmed ? 'confirmed' : page.status === 200 ? 'partly-confirmed' : 'unreachable',
    evidence
  };
  results.push(entry);
  process.stdout.write(`${confirmed ? 'CONFIRMED ' : page.status === 200 ? 'PARTIAL   ' : 'UNREACHED '} ${check.id.padEnd(34)} ${evidence.filter((e) => e.found).length}/${evidence.length} fragments\n`);
  for (const item of evidence) {
    if (!item.found) process.stdout.write(`             missing: ${item.pattern}\n`);
  }
}

const confirmedCount = results.filter((entry) => entry.status === 'confirmed').length;
const payload = {
  note: 'Plan and policy claims re-checked against their primary sources. A confirmed entry means the page contained the required sentence fragments on checkedAt; it is evidence about documentation, not a measurement of the platform.',
  checkedAt,
  source: 'tools/check-policies.mjs',
  summary: { total: results.length, confirmed: confirmedCount, partlyConfirmed: results.filter((e) => e.status === 'partly-confirmed').length, unreachable: results.filter((e) => e.status === 'unreachable').length },
  checks: results
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
process.stdout.write(`\n${confirmedCount}/${results.length} confirmed — wrote ${path.relative(root, outFile)}\n`);
