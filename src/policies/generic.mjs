/**
 * Generic safety rules: credentials and private material that must never be published.
 *
 * These rules are universal — every artifact, in every project, in every policy. A hit is a hard
 * block: the CLI refuses to upload until the file is removed or renamed. They deliberately
 * over-match (a false positive costs a rename) but only on names that carry secrets.
 */

export const NAME = 'generic';

export const DESCRIPTION = 'Credential and private-material names that are never safe to publish.';

export const RULES = [
  { id: 'dotenv', severity: 'blocked', pattern: /^\.env(\..+)?$/i, reason: 'environment file (may hold API keys)' },
  { id: 'env-any', severity: 'blocked', pattern: /(^|[._-])env(\.(local|production|development|staging|test))?$/i, reason: 'environment file (may hold API keys)' },
  { id: 'pem', severity: 'blocked', pattern: /\.pem$/i, reason: 'private key material' },
  { id: 'key', severity: 'blocked', pattern: /\.key$/i, reason: 'private key material' },
  { id: 'pkcs12', severity: 'blocked', pattern: /\.(p12|pfx)$/i, reason: 'private key material' },
  { id: 'id-rsa', severity: 'blocked', pattern: /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, reason: 'SSH private key' },
  { id: 'ssh-key', severity: 'blocked', pattern: /^\.ssh$/i, reason: 'SSH key directory' },
  { id: 'credentials', severity: 'blocked', pattern: /^credentials\.json$/i, reason: 'cloud credential file' },
  { id: 'aws-credentials', severity: 'blocked', pattern: /^\.aws$/i, reason: 'cloud credential directory' },
  { id: 'cloud-token', severity: 'blocked', pattern: /(cloudflared|cloudflare|wrangler|vercel|netlify|gh|github|npm|yarn|pypi|docker|kube)[._-]?(token|credential|credentials|secret|auth)\.(json|ya?ml|toml|txt|ini)$/i, reason: 'cloud provider token file' },
  { id: 'netrc', severity: 'blocked', pattern: /^\.?netrc$/i, reason: 'stored plaintext credentials' },
  { id: 'npmrc', severity: 'blocked', pattern: /^\.npmrc$/i, reason: 'registry auth token' },
  { id: 'htpasswd', severity: 'blocked', pattern: /^\.?htpasswd$/i, reason: 'credential file' },
  { id: 'secrets', severity: 'blocked', pattern: /(^|[._-])secrets?(\.(json|ya?ml|toml|txt|ini|env))?$/i, reason: 'secret store file' },
  { id: 'service-account', severity: 'blocked', pattern: /service[._-]?account.*\.json$/i, reason: 'cloud service-account key' }
];

/** Directories whose presence anywhere in the artifact is a hard block. */
export const SENSITIVE_DIRECTORIES = ['.git', '.ssh', '.aws', '.env.d', '.netlify/state', '.vercel'];

/**
 * Extensions that can carry records. A `severity: 'data'` rule only escalates to a hard block when
 * the file has one of these extensions (or no extension at all): `grades.html` is a leak, but a
 * component literally named `grade.js` usually is not.
 */
export const DATA_EXTENSIONS = new Set([
  '.csv', '.tsv', '.xlsx', '.xls', '.ods', '.json', '.yaml', '.yml', '.txt', '.dat',
  '.db', '.sqlite', '.sqlite3', '.parquet', '.xml', '.pdf', '.docx', '.doc'
]);
