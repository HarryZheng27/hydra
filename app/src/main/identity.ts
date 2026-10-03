import path from 'node:path';

/**
 * The app's identity, in one place. The app is "Hydra"; the IDE is "Hydra IDE" (docs/internal/Hydra_App_Plan.md,
 * Naming). They must never share a data folder: Electron would default this app's user data to %APPDATA%\Hydra,
 * the IDE's real profile, because productName is "Hydra" (G1's spike wrote there by accident). Electron's
 * single-instance lock takes no name and is keyed on the user-data folder, so setting the folder first also keeps
 * the two apps' locks apart.
 */
export const PRODUCT_NAME = 'Hydra';
/** %APPDATA%\Hydra App. */
export const USER_DATA_FOLDER = 'Hydra App';
export const APP_USER_MODEL_ID = 'Hydra.App';
/** The IDE's %APPDATA%\Hydra. Nothing the app writes may resolve inside it, except G5's shared storage root. */
export const IDE_USER_DATA_FOLDER = 'Hydra';

/** The Electron paths the app owns, every one of which must sit under its own user data. */
export const OWNED_PATHS = ['userData', 'sessionData', 'logs', 'crashDumps'] as const;
export type OwnedPath = typeof OWNED_PATHS[number];

export interface IdentityApp {
  getPath(name: 'appData' | OwnedPath): string;
  setPath(name: OwnedPath, value: string): void;
  setName(name: string): void;
  setAppUserModelId(id: string): void;
  setAppLogsPath(value?: string): void;
}

export const appUserData = (appData: string): string => path.join(appData, USER_DATA_FOLDER);
export const ideUserData = (appData: string): string => path.join(appData, IDE_USER_DATA_FOLDER);

const sameOrInside = (child: string, parent: string): boolean => {
  const relative = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
};

/** True when `target` is the IDE's user data folder or inside it. Windows paths compare case-insensitively. */
/**
 * The one folder inside the IDE's data the app uses (G5): the Hydra extension's own global storage, which the IDE's
 * windows and the app share for heads, plans, ownership and discovery. The app's own data never goes there, and
 * nothing else of the IDE's is touched. Tests point it at a folder of their own (`HYDRA_APP_IDE_STORAGE`).
 */
export const EXTENSION_STORAGE_ID = 'nico-dunlap.hydra-agent-manager';
export function ideHydraStorage(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HYDRA_APP_IDE_STORAGE) return env.HYDRA_APP_IDE_STORAGE;
  const appData = env.APPDATA ?? path.join(env.USERPROFILE ?? '', 'AppData', 'Roaming');
  return path.join(ideUserData(appData), 'User', 'globalStorage', EXTENSION_STORAGE_ID);
}
export const insideIdeUserData = (target: string, appData: string): boolean => sameOrInside(target, ideUserData(appData));

/**
 * Points every path the app owns at %APPDATA%\Hydra App, and sets the Windows AppUserModelId. main.ts calls this
 * as its first statement, before the single-instance lock or any window, cache or log can be created.
 */
export function applyIdentity(app: IdentityApp): string {
  const userData = appUserData(app.getPath('appData'));
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setAppLogsPath(path.join(userData, 'logs'));
  app.setPath('crashDumps', path.join(userData, 'Crashpad'));
  app.setName(PRODUCT_NAME);
  app.setAppUserModelId(APP_USER_MODEL_ID);
  return userData;
}

/** Every owned path that resolves outside the app's own folder or into the IDE's; empty when the identity holds. */
export function identityProblems(app: Pick<IdentityApp, 'getPath'>): string[] {
  const appData = app.getPath('appData'), own = appUserData(appData);
  const problems: string[] = [];
  for (const name of OWNED_PATHS) {
    const value = app.getPath(name);
    if (!sameOrInside(value, own)) problems.push(`${name} is outside ${USER_DATA_FOLDER}: ${value}`);
    if (insideIdeUserData(value, appData)) problems.push(`${name} is inside the IDE's user data: ${value}`);
  }
  return problems;
}
