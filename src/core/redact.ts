/**
 * 5.1 (docs/Hydra_Improvements.md): one redactor, used everywhere Hydra shows text that
 * might contain a secret (the output channel, head transcripts, gate evidence). It masks
 * exact secret values it's told about, environment variables whose name looks secret, and
 * known token shapes, without touching ordinary text: paths, hashes, commit SHAs, UUIDs,
 * JSON numbers and `${ENV_REF}` references all pass through unchanged.
 *
 * `secretKeyPattern` and `secretPrefixPattern` used to live in mcpServers.ts (the Settings
 * MCP page); they're here now, and mcpServers.ts imports them back, so both places use the
 * same name and shape rules.
 */

/** A key name that looks like it holds a secret: TOKEN, KEY, SECRET, PASSWORD, AUTH, SESSION, … */
export const secretKeyPattern = /token|secret|passw|api[-_]?key|apikey|auth(?!or)|credential|private[-_]?key|access[-_]?key|client[-_]?key|session|cookie|bearer|signature|(^|[-_])key($|[-_])/i;
/** A value shape that looks like a known secret token, by its prefix. */
export const secretPrefixPattern = /^(sk-|sk_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|ya29\.|npm_|pypi-|hf_|shpat_|SG\.|lin_api_|eyJ)/;

/**
 * Whether a value should be masked: by its key (TOKEN, KEY, SECRET, PASSWORD, AUTH, …) or by
 * its shape (known token prefixes, "Bearer …", long random strings). An environment-variable
 * reference like `${GITHUB_TOKEN}` is not a secret.
 */
export function looksLikeSecret(key: string | undefined, value: string): boolean {
  if (!value || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return false;
  if (key && secretKeyPattern.test(key)) return true;
  const bare = value.replace(/^(Bearer|Basic|token)\s+/i, '');
  if (bare !== value) return bare.length >= 8;
  if (secretPrefixPattern.test(bare) && bare.length >= 12) return true;
  return bare.length >= 24 && /^[A-Za-z0-9_\-+=]+$/.test(bare) && /\d/.test(bare) && /[A-Za-z]/.test(bare) && !/^\d[\d-]*$/.test(bare);
}

const replacement = '[redacted]';
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isEnvRef = (value: string): boolean => /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value);
/** A value worth masking as a key/value pair: long enough, not a bare number, not an env reference. */
const qualifies = (value: string): boolean => value.length >= 8 && !/^\d+$/.test(value) && !isEnvRef(value);

// ---- Environment variables whose name looks secret, computed once and cached ----

let cachedEnvSecrets: string[] | undefined;
/** Clears the cached list of environment-variable secret values (tests change `process.env`). */
export function resetRedactionCache(): void { cachedEnvSecrets = undefined; }
function envSecretValues(): string[] {
  if (cachedEnvSecrets) return cachedEnvSecrets;
  cachedEnvSecrets = Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length >= 8 && secretKeyPattern.test(entry[0]))
    .map(([, value]) => value);
  return cachedEnvSecrets;
}

// ---- Exact values (planted secrets, live tokens, env values), longest first ----

function maskExactValues(text: string, secrets: Iterable<string>): string {
  const values = [...new Set([...secrets].filter(value => value.length >= 8))].sort((a, b) => b.length - a.length);
  if (!values.length) return text;
  const pattern = new RegExp(values.map(escapeRegExp).join('|'), 'g');
  return text.replace(pattern, replacement);
}

// ---- PEM private key blocks (whole block, multi-line) ----

const pemPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const maskPem = (text: string): string => text.replace(pemPattern, replacement);

// ---- Authorization headers, and Bearer / Basic values anywhere ----

const authorizationHeaderPattern = /^([ \t]*Authorization[ \t]*:[ \t]*).+$/gim;
const maskAuthorizationHeaders = (text: string): string => text.replace(authorizationHeaderPattern, (_whole, prefix: string) => `${prefix}${replacement}`);
const bearerBasicPattern = /\b(Bearer|Basic)[ \t]+([^\s"'<>]+)/g;
const maskBearerBasic = (text: string): string => text.replace(bearerBasicPattern, (whole, scheme: string, value: string) => value.length >= 8 ? `${scheme} ${replacement}` : whole);

// ---- Passwords in URLs: scheme://user:pass@host -> scheme://user:[redacted]@host ----

const urlPasswordPattern = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/:@]+):([^\s\/@]+)@/g;
const maskUrlPasswords = (text: string): string => text.replace(urlPasswordPattern, (_whole, userPart: string) => `${userPart}:${replacement}@`);

// ---- Known token shapes ----

const tokenShapePatterns: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bsk_[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_-]{10,}\b/g, // ghp_ gho_ ghu_ ghs_ ghr_
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{10,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bshpat_[A-Za-z0-9]{20,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\blin_api_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
];
const maskTokenShapes = (text: string): string => tokenShapePatterns.reduce((acc, pattern) => acc.replace(pattern, replacement), text);

// ---- key=value, key: value, "key": "value" ----

const jsonPairPattern = /"([A-Za-z][\w-]{1,60})"[ \t]*:[ \t]*"((?:[^"\\]|\\.)*)"/g;
const maskJsonPairs = (text: string): string => text.replace(jsonPairPattern, (whole, key: string, value: string) => secretKeyPattern.test(key) && qualifies(value) ? `"${key}": "${replacement}"` : whole);

// A bare or quoted "key: value" line (YAML-ish). The value stops at end of line, a comma or a closing bracket.
const colonPairPattern = /\b([A-Za-z][\w-]{1,60})[ \t]*:[ \t]+(?!\/\/)(['"]?)([^\s,;}\]"']+)\2/g;
const maskColonPairs = (text: string): string => text.replace(colonPairPattern, (whole, key: string, quote: string, value: string) => secretKeyPattern.test(key) && qualifies(value) ? `${key}: ${quote}${replacement}${quote}` : whole);

// key=value (env-file / CLI style), quoted or bare.
const equalsPairPattern = /\b([A-Za-z_][\w-]{1,60})=(['"]?)([^\s,;}\]"']+)\2/g;
const maskEqualsPairs = (text: string): string => text.replace(equalsPairPattern, (whole, key: string, quote: string, value: string) => secretKeyPattern.test(key) && qualifies(value) ? `${key}=${quote}${replacement}${quote}` : whole);

/**
 * Mask secrets in free text: exact values (planted secrets, live tokens), environment
 * variables whose name looks secret, known token shapes, Bearer/Basic values and
 * Authorization headers, PEM private key blocks, passwords in URLs, and key/value pairs
 * whose key looks secret. Everything else — paths, hashes, commit SHAs, UUIDs, ordinary
 * prose, JSON numbers, `${ENV_REF}` references — passes through unchanged.
 */
export function redactText(text: string, secrets: Iterable<string> = []): string {
  if (!text) return text;
  let out = text;
  out = maskExactValues(out, [...secrets, ...envSecretValues()]);
  out = maskPem(out);
  out = maskAuthorizationHeaders(out);
  out = maskBearerBasic(out);
  out = maskUrlPasswords(out);
  out = maskTokenShapes(out);
  out = maskJsonPairs(out);
  out = maskColonPairs(out);
  out = maskEqualsPairs(out);
  return out;
}

/** A bound redactor whose live secrets (Hydra's own endpoint tokens, when reachable) are read fresh each call. */
export function createRedactor(liveSecrets: () => Iterable<string>): (text: string) => string {
  return (text: string) => redactText(text, liveSecrets());
}
