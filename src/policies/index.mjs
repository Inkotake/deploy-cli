/**
 * Pre-publish safety policy.
 *
 * The scan runs before any provider is contacted and its hard blocks are absolute: nothing is
 * uploaded while a blocked file is present. Rules are grouped into policies so the same engine can
 * serve a general-purpose tool (`generic`, the default) and a classroom tool (`teacher`, opt-in via
 * `--policy teacher`), without the core pretending that every artifact called `results.csv` is
 * somebody's gradebook.
 */

import * as generic from './generic.mjs';
import * as teacher from './teacher.mjs';

export const DEFAULT_POLICY = 'generic';
export const POLICY_NAMES = ['generic', 'teacher'];

const MODULES = new Map([
  [generic.NAME, generic],
  [teacher.NAME, teacher]
]);

/** Rule sets a policy activates. `teacher` extends `generic`: secrets are still never publishable. */
const POLICY_RULES = {
  generic: [generic.NAME],
  teacher: [generic.NAME, teacher.NAME]
};

/** Every policy name with its description and rule count, for `doctor` and `--help`. */
export function listPolicies() {
  return POLICY_NAMES.map((name) => {
    const policy = loadPolicy(name);
    return { name, description: policy.description, ruleCount: policy.rules.length };
  });
}

export function isPolicyName(name) {
  return POLICY_NAMES.includes(String(name));
}

/**
 * Resolve a policy name into a usable rule set. Throws on an unknown name: silently falling back to
 * the generic policy would turn a typo into a weaker safety guarantee than the caller asked for.
 */
export function loadPolicy(name = DEFAULT_POLICY) {
  const key = String(name || DEFAULT_POLICY);
  if (!POLICY_RULES[key]) {
    const error = new Error(`unknown policy "${key}" (expected one of ${POLICY_NAMES.join(', ')})`);
    error.code = 'EUNKNOWNPOLICY';
    throw error;
  }
  const modules = POLICY_RULES[key].map((moduleName) => MODULES.get(moduleName));
  return {
    name: key,
    description: modules.map((mod) => mod.DESCRIPTION).join(' '),
    rules: modules.flatMap((mod) => mod.RULES),
    sensitiveDirectories: modules.flatMap((mod) => (mod.SENSITIVE_DIRECTORIES ? mod.SENSITIVE_DIRECTORIES : [])),
    dataExtensions: generic.DATA_EXTENSIONS
  };
}

/** Rule hits for one file or directory name. Returns `{ id, reason, severity }` entries. */
export function safetyScanName(name, policy = DEFAULT_POLICY) {
  const resolved = typeof policy === 'string' ? loadPolicy(policy) : policy;
  const hits = [];
  for (const rule of resolved.rules) {
    if (rule.pattern.test(name)) hits.push({ id: rule.id, reason: rule.reason, severity: rule.severity });
  }
  return hits;
}

/** True when a path can carry records, so a `severity: 'data'` rule must be treated as a block. */
export function isDataBearing(relPath, policy = DEFAULT_POLICY) {
  const resolved = typeof policy === 'string' ? loadPolicy(policy) : policy;
  const extension = /\.[^./\\]+$/.exec(String(relPath).split(/[\\/]/).pop() || '');
  if (!extension) return true; // no extension: the name is all we have to go on
  return resolved.dataExtensions.has(extension[0].toLowerCase());
}

/**
 * Classify one artifact-relative path.
 * @returns {null | { severity: 'blocked' | 'warning', rules: string[], reasons: string[] }}
 */
export function classifyBlock(relPath, policy = DEFAULT_POLICY) {
  const resolved = typeof policy === 'string' ? loadPolicy(policy) : policy;
  const basename = String(relPath).split(/[\\/]/).pop() || '';
  const hits = safetyScanName(basename, resolved);
  if (!hits.length) return null;

  const hard = hits.filter((hit) => hit.severity === 'blocked');
  if (hard.length) {
    return {
      severity: 'blocked',
      rules: hard.map((hit) => hit.id),
      reasons: [...new Set(hard.map((hit) => hit.reason))]
    };
  }

  const data = hits.filter((hit) => hit.severity === 'data');
  if (!data.length) return null;
  const verdict = {
    rules: data.map((hit) => hit.id),
    reasons: [...new Set(data.map((hit) => hit.reason))]
  };
  return isDataBearing(relPath, resolved)
    ? { severity: 'blocked', ...verdict }
    : { severity: 'warning', ...verdict };
}

/** Directory names that are blocked outright; returns the rule id or null. */
export function classifyDirectory(relPath, policy = DEFAULT_POLICY) {
  const resolved = typeof policy === 'string' ? loadPolicy(policy) : policy;
  const basename = String(relPath).split(/[\\/]/).pop() || '';
  return resolved.sensitiveDirectories.includes(basename) ? 'sensitive-directory' : null;
}
