import { matchesAnyGlob } from '../utils/path-safety';

/**
 * One secret-exclusion policy, applied everywhere a repository file can reach a
 * model: indexing, search, reads, diffs and artifacts.
 *
 * The audit's S5 finding was that these lived only in each agent's `denyPaths`,
 * so the *indexer* — which has no agent and therefore no permission profile —
 * happily read `.env` and fed a ranked summary of it straight into a prompt.
 * A single exported predicate is the fix: every read path calls `isSecretPath`
 * before opening the file, and retrieval calls it again before rendering.
 *
 * Deliberately a denylist, unlike the path-containment checks in `path-safety`.
 * Containment can be decided positively because the question is "is this inside
 * the root"; "is this a credential" cannot be, because credentials live under
 * arbitrary names. The mitigation is that a false negative here is contained by
 * the other controls (no egress from the executor, human publication approval),
 * whereas a false positive only hides a file from an agent.
 */

/** Files that are almost always credentials, matched against the full relative path. */
const SECRET_GLOBS: string[] = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/*.ppk',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/secrets/**',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/_netrc',
  '**/.htpasswd',
  '**/.git-credentials',
  '**/credentials.json',
  '**/credentials.yml',
  '**/credentials.yaml',
  '**/service-account*.json',
  '**/serviceaccount*.json',
  '**/*service-account-key*.json',
  '**/.terraform/**',
  '**/terraform.tfstate',
  '**/terraform.tfstate.*',
  '**/*.tfvars',
  '.git/**',
  '**/.git/**',
];

/**
 * Templates that document which variables exist without holding real values.
 * Excluding these from the denylist is what lets an agent learn the shape of a
 * project's configuration — genuinely useful context — without seeing secrets.
 */
const TEMPLATE_GLOBS: string[] = [
  '**/.env.example',
  '**/.env.sample',
  '**/.env.template',
  '**/.env.defaults',
  '**/.env.test',
  '.env.example',
  '.env.sample',
  '.env.template',
  '**/*.tfvars.example',
];

/**
 * True when a repository-relative path must never be read, indexed, searched or
 * rendered into a prompt.
 *
 * `relativePath` is expected to already be canonical (see `canonicalRelative`);
 * passing a raw model-supplied string still works for the common cases but is
 * not the supported contract, because `a/../.env` would not match.
 */
export function isSecretPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (matchesAnyGlob(TEMPLATE_GLOBS, normalized)) return false;
  return matchesAnyGlob(SECRET_GLOBS, normalized);
}

/** Filter a list of repository-relative paths down to the readable ones. */
export function withoutSecretPaths<T>(items: T[], pathOf: (item: T) => string): T[] {
  return items.filter((item) => !isSecretPath(pathOf(item)));
}

/** The globs themselves, for surfacing the policy in the UI and in agent prompts. */
export function secretPathPolicy(): { denied: string[]; allowedTemplates: string[] } {
  return { denied: [...SECRET_GLOBS], allowedTemplates: [...TEMPLATE_GLOBS] };
}

/**
 * Redact credential-shaped values from text that is about to be logged, stored
 * as an artifact, or shown to an operator.
 *
 * This is a second line of defence for content that already passed the path
 * filter — a hardcoded key inside an ordinary source file, a token echoed into
 * command output, a clone URL in an error string (S11).
 */
const REDACTION_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // URL userinfo: https://user:token@host → https://***@host
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replacement: '$1***:***@' },
  // Bearer / token headers
  { pattern: /\b(bearer|token|authorization)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: '$1 [redacted]' },
  // Provider key formats
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replacement: '[redacted-anthropic-key]' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/g, replacement: '[redacted-key]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: '[redacted-github-token]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: '[redacted-github-token]' },
  { pattern: /\bAIza[A-Za-z0-9_-]{30,}/g, replacement: '[redacted-google-key]' },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: '[redacted-aws-key-id]' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: '[redacted-slack-token]' },
  // PEM blocks
  {
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replacement: '[redacted-private-key]',
  },
  // key=value / "key": "value" assignments for secret-looking names
  {
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"',;]{6,})["']?/gi,
    replacement: '$1=[redacted]',
  },
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let output = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}
