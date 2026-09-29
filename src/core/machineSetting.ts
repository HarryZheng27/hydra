/**
 * Settings that decide what Hydra runs (the Claude and Codex executables, the packs folder, where worktrees go,
 * whether third-party tools get installed) are declared `"scope": "machine"` in package.json, so VS Code ignores
 * them in a repository's `.vscode/settings.json`. This helper is the second layer: even if a workspace value ever
 * reached the configuration, only the user (global) value and the packaged default are read.
 */
export interface InspectableConfiguration {
  inspect<T>(section: string): { globalValue?: T; defaultValue?: T } | undefined;
}

/** The user's value for `key`, else its default; never a workspace, folder or language-override value. */
export function machineSetting<T>(config: InspectableConfiguration, key: string): T | undefined {
  const inspected = config.inspect<T>(key);
  return inspected?.globalValue ?? inspected?.defaultValue;
}
