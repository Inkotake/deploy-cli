/**
 * Single source of truth for this tool's identity and environment contract.
 *
 * WHY THIS FILE EXISTS: the CLI was extracted from a desktop product where the command name, log
 * prefix, user agent, multipart boundary and five environment variables were hard-coded across
 * several modules. Renaming the tool, or shipping it under a different package name, must never
 * require editing anything except this file and `package.json`.
 *
 * Legacy compatibility: the previous product's variable names are still read as *fallbacks* so the
 * existing desktop distribution keeps working while it migrates. A new name always wins.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPackage() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

const pkg = readPackage();

/** Package name, as published. */
export const NAME = typeof pkg.name === 'string' && pkg.name ? pkg.name : 'vpublish';
/** Package version; also the value reported by `--version`. */
export const VERSION = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
/** Executable name generated from `package.json#bin`. */
export const COMMAND = 'vpublish';

/** Version of the `--json` stdout contract. Bump only for a breaking payload change. */
export const SCHEMA_VERSION = 1;
/** Version of the provider `capabilities` object schema in `config/providers.json`. */
export const CAPABILITY_SCHEMA = 1;

export const LOG_PREFIX = `[${COMMAND}] `;

const repositoryUrl = typeof pkg.repository === 'string'
  ? pkg.repository
  : pkg.repository && typeof pkg.repository.url === 'string' ? pkg.repository.url : null;

/**
 * The user agent must be a plain, clickable URL: package manifests spell repositories as
 * `git+https://…​.git`, which is correct for npm and noise in a request header.
 */
const userAgentUrl = repositoryUrl ? repositoryUrl.replace(/^git\+/, '').replace(/\.git$/, '') : null;

/**
 * User agent sent with every provider request. It is the only place a hosting service sees who is
 * calling, so it must not claim a project that does not exist: when `package.json` has no
 * repository URL yet, the plain `name/version` token is sent instead of a placeholder link.
 */
export const USER_AGENT = userAgentUrl ? `${NAME}/${VERSION} (+${userAgentUrl})` : `${NAME}/${VERSION}`;

/** Multipart boundary prefix. Purely cosmetic, but it shows up in packet captures and logs. */
export const BOUNDARY_PREFIX = '----vpublish';

/** State directory used when no environment variable overrides it. */
export const DEFAULT_STATE_DIR = `.${NAME}`;

/**
 * Environment variables, newest first. The older spellings are still read so a deployment that
 * exported them — including the desktop product this was extracted from — keeps working unchanged;
 * the first name that is set wins.
 */
export const ENV = {
  home: ['VPUBLISH_HOME', 'VERIFIED_PUBLISH_HOME', 'TEACHER_DSH_HOME', 'TEACHER_HOME'],
  deployBin: ['VPUBLISH_DEPLOY_BIN', 'VERIFIED_PUBLISH_DEPLOY_BIN', 'TEACHER_DEPLOY_BIN'],
  deployHome: ['VPUBLISH_DEPLOY_HOME', 'VERIFIED_PUBLISH_DEPLOY_HOME', 'TEACHER_DEPLOY_HOME'],
  registry: ['VPUBLISH_REGISTRY', 'VERIFIED_PUBLISH_REGISTRY', 'TEACHER_PUBLISH_REGISTRY'],
  statusFile: ['VPUBLISH_STATUS_FILE', 'VERIFIED_PUBLISH_STATUS_FILE', 'TEACHER_PUBLISH_STATUS_FILE'],
  policy: ['VPUBLISH_POLICY', 'VERIFIED_PUBLISH_POLICY'],
  region: ['VPUBLISH_REGION', 'VERIFIED_PUBLISH_REGION'],
  proxy: ['VPUBLISH_PROXY', 'VERIFIED_PUBLISH_PROXY']
};

export const FILES = {
  health: 'publish-provider-health.json',
  status: 'publish-provider-status.json',
  claims: 'claims.json'
};

/** Strings that identify artifacts and git content this tool created. */
export const MARKERS = {
  ghPagesStagingPrefix: `.${NAME}-gh-pages`,
  netlifyMessage: COMMAND,
  commitSubject: `${COMMAND} static artifact`,
  /** Commit trailer written into a published branch, and the older spelling still honoured. */
  trailer: 'X-Vpublish',
  legacyTrailers: ['X-Verified-Publish'],
  /** Recorded in the registry/deploy JSON so a caller can tell which tool produced a result. */
  producedBy: `${NAME}/${VERSION}`
};

/**
 * First non-empty value among `names` in `env`, or null. Used so a renamed variable can be
 * introduced without breaking the existing deployment that still exports the old one.
 */
export function pickEnv(env, names) {
  const source = env || {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && String(value).length > 0) return String(value);
  }
  return null;
}

/** Names that are currently read, for `doctor` output and documentation. */
export function envContract() {
  return Object.entries(ENV).map(([key, names]) => ({ key, names, active: names[0], legacy: names.slice(1) }));
}
