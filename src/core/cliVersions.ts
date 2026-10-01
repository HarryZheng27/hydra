/**
 * Which provider CLI versions Hydra runs (docs/internal/Official_Extensions_Plan.md,
 * decision 5). Hydra accepts the tested release or any newer one with the same
 * major version: Claude Code 2.1.270 and up within 2.x, Codex 0.154.0 and up
 * within 0.x. Providers ship often, so pinning a patch line broke sign-in and
 * heads with every update; each new binary still gets a one-time real
 * self-check before a head uses it, and account setup reads only fields it
 * validates.
 */
export type CliProvider = 'claude' | 'codex';
interface Minimum { major: number; minor: number; patch: number }
/** The oldest tested release; anything newer with the same major version is accepted. */
export const supportedCliMinimums: Readonly<Record<CliProvider, Minimum>> = {
  claude: { major: 2, minor: 1, patch: 270 },
  codex: { major: 0, minor: 154, patch: 0 },
};
export const supportedCliMinimum = (provider: CliProvider): string => { const m = supportedCliMinimums[provider]; return `${m.major}.${m.minor}.${m.patch}`; };
export const supportedCliDescription = (provider: CliProvider): string =>
  `${provider === 'claude' ? 'Claude Code' : 'Codex'} ${supportedCliMinimum(provider)} or newer (${supportedCliMinimums[provider].major}.x)`;

/** The first x.y.z in a version string such as "2.1.281 (Claude Code)" or "codex-cli 0.154.3". Pre-release tags make it unsupported. */
export function parseCliVersion(value: unknown): { major: number; minor: number; patch: number; prerelease: boolean } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: !!match[4] };
}

export function supportedCliVersion(provider: CliProvider, value: unknown): boolean {
  const version = parseCliVersion(value), minimum = supportedCliMinimums[provider];
  if (!version || version.prerelease || version.major !== minimum.major) return false;
  return version.minor > minimum.minor || (version.minor === minimum.minor && version.patch >= minimum.patch);
}

/** The supported x.y.z inside a string (a user agent, a version line), or undefined. */
export function supportedCliVersionIn(provider: CliProvider, value: unknown): string | undefined {
  const version = parseCliVersion(value);
  return version && supportedCliVersion(provider, value) ? `${version.major}.${version.minor}.${version.patch}` : undefined;
}
