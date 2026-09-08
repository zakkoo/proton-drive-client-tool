/**
 * Secret redaction for every log sink.
 *
 * Two layers:
 *  1. Known secrets: modules that handle credentials register the exact
 *     secret strings they hold (tokens, passwords, key passwords). Any
 *     occurrence anywhere in a logged value is replaced.
 *  2. Structural rules: object keys that name secrets are redacted wholesale,
 *     and string values matching well-known secret shapes (bearer tokens,
 *     JWT-like tokens, PGP armored blocks) are masked.
 *
 * Content digests (40 hex chars) and node identifiers are deliberately not
 * matched by the value rules, since the audit log depends on them.
 */

const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN =
  /(password|passphrase|secret|token|authorization|cookie|privatekey|private_key|keypassword|key_password|accesstoken|access_token|refreshtoken|refresh_token|x-pm-uid|srp|clientproof|client_proof|serverproof|verifier|mailboxpassword|mailbox_password)/i;

const VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /-----BEGIN PGP [A-Z ]+-----[\s\S]*?-----END PGP [A-Z ]+-----/g,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
];

export class SecretRegistry {
  private readonly secrets = new Set<string>();

  /** Register an exact secret string. Short or empty values are ignored. */
  register(secret: string | undefined | null): void {
    if (typeof secret === 'string' && secret.length >= 6) {
      this.secrets.add(secret);
    }
  }

  unregister(secret: string): void {
    this.secrets.delete(secret);
  }

  size(): number {
    return this.secrets.size;
  }

  /** Longest secrets first so that a secret containing another is masked whole. */
  private sorted(): string[] {
    return [...this.secrets].sort((a, b) => b.length - a.length);
  }

  redactString(value: string): string {
    let out = value;
    for (const secret of this.sorted()) {
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED);
      }
    }
    for (const pattern of VALUE_PATTERNS) {
      out = out.replace(pattern, REDACTED);
    }
    return out;
  }
}

/** Process-wide registry shared by all sinks. */
export const secretRegistry = new SecretRegistry();

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Deep-redact any value. Objects and arrays are copied; cycles are cut.
 */
export function redact(value: unknown, registry: SecretRegistry = secretRegistry): unknown {
  const seen = new WeakSet<object>();

  const walk = (v: unknown, keyHint?: string): unknown => {
    if (keyHint !== undefined && isSecretKey(keyHint) && v !== undefined && v !== null) {
      return REDACTED;
    }
    if (typeof v === 'string') {
      return registry.redactString(v);
    }
    if (v === null || typeof v !== 'object') {
      return v;
    }
    if (v instanceof Error) {
      return {
        name: v.name,
        message: registry.redactString(v.message),
        ...(v.stack !== undefined ? { stack: registry.redactString(v.stack) } : {}),
      };
    }
    if (seen.has(v)) {
      return '[Circular]';
    }
    seen.add(v);
    if (Array.isArray(v)) {
      return v.map((item) => walk(item));
    }
    if (v instanceof Date) {
      return v.toISOString();
    }
    if (v instanceof Map) {
      return walk(Object.fromEntries(v));
    }
    if (v instanceof Set) {
      return walk([...v]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(item, k);
    }
    return out;
  };

  return walk(value);
}

export { REDACTED };
