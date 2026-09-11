/**
 * The pre-publish safety scan.
 *
 * The rule set is deliberately small, fixed and *not* configurable: credentials, private keys and
 * sensitive directories. Those are unsafe to publish under any circumstances, in any product, which
 * is exactly why they belong in the core rather than in a plug-in.
 *
 * Project- or sector-specific rules do NOT belong here. A classroom product may well refuse to
 * publish `grades.csv`; an upstream tool that guesses what a given user's data means will be wrong
 * for everyone else, and a rule that is wrong is worse than no rule because it teaches people to
 * bypass the scan. A downstream product enforces its own rules itself: `inspect --json` lists every
 * path in the artifact with its size and hash, so a consumer can apply its own list and decide before
 * it ever calls `deploy`. See `docs/consuming.md`.
 *
 * The scan is name-based and deliberately over-matches. A false positive costs a rename; a false
 * negative puts a private key on a public URL.
 */

export const NAME = 'safety';
export const DESCRIPTION = 'Credential and private-material names that are never safe to publish.';

export const RULES = [
  { id: 'dotenv', pattern: /^\.env(\..+)?$/i, reason: 'environment file (may hold API keys)' },
  { id: 'env-any', pattern: /(^|[._-])env(\.(local|production|development|staging|test))?$/i, reason: 'environment file (may hold API keys)' },
  { id: 'pem', pattern: /\.pem$/i, reason: 'private key material' },
  { id: 'key', pattern: /\.key$/i, reason: 'private key material' },
  { id: 'pkcs12', pattern: /\.(p12|pfx)$/i, reason: 'private key material' },
  { id: 'id-rsa', pattern: /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, reason: 'SSH private key' },
  { id: 'ssh-key', pattern: /^\.ssh$/i, reason: 'SSH key directory' },
  { id: 'credentials', pattern: /^credentials\.json$/i, reason: 'cloud credential file' },
  { id: 'aws-credentials', pattern: /^\.aws$/i, reason: 'cloud credential directory' },
  { id: 'cloud-token', pattern: /(cloudflared|cloudflare|wrangler|vercel|netlify|gh|github|npm|yarn|pypi|docker|kube)[._-]?(token|credential|credentials|secret|auth)\.(json|ya?ml|toml|txt|ini)$/i, reason: 'cloud provider token file' },
  { id: 'netrc', pattern: /^\.?netrc$/i, reason: 'stored plaintext credentials' },
  { id: 'npmrc', pattern: /^\.npmrc$/i, reason: 'registry auth token' },
  { id: 'htpasswd', pattern: /^\.?htpasswd$/i, reason: 'credential file' },
  { id: 'secrets', pattern: /(^|[._-])secrets?(\.(json|ya?ml|toml|txt|ini|env))?$/i, reason: 'secret store file' },
  { id: 'service-account', pattern: /service[._-]?account.*\.json$/i, reason: 'cloud service-account key' }
];

/** Directories whose presence anywhere in the artifact is a hard block. */
export const SENSITIVE_DIRECTORIES = ['.git', '.ssh', '.aws', '.env.d', '.netlify/state', '.vercel'];

/** Rule hits for one file or directory name. */
export function safetyScanName(name) {
  const hits = [];
  for (const rule of RULES) {
    if (rule.pattern.test(String(name))) hits.push({ id: rule.id, reason: rule.reason });
  }
  return hits;
}

/**
 * Classify one artifact-relative path.
 * @returns {null | { severity: 'blocked', rules: string[], reasons: string[] }}
 */
export function classifyBlock(relPath) {
  const basename = String(relPath).split(/[\\/]/).pop() || '';
  const hits = safetyScanName(basename);
  if (!hits.length) return null;
  return {
    severity: 'blocked',
    rules: hits.map((hit) => hit.id),
    reasons: [...new Set(hits.map((hit) => hit.reason))]
  };
}

/**
 * Sensitive directory names; returns the rule id or null.
 *
 * Basenames are compared for the ordinary entries, and the full relative path for entries that name
 * a nested directory (`.netlify/state`): a basename comparison can never match those, which is how
 * such an entry silently stops protecting anything.
 */
export function classifyDirectory(relPath) {
  const posix = String(relPath).split(/[\\/]/).join('/');
  const basename = posix.split('/').pop() || '';
  if (SENSITIVE_DIRECTORIES.includes(basename)) return 'sensitive-directory';
  const nested = SENSITIVE_DIRECTORIES.some((entry) => entry.includes('/')
    && (posix === entry || posix.endsWith('/' + entry)));
  return nested ? 'sensitive-directory' : null;
}
