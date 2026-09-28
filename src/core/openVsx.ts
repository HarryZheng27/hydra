import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Download an extension's VSIX straight from Open VSX, for installing when the
 * editor has no extension gallery configured (older Hydra builds). Picks this
 * platform's build, else the universal one.
 */
export function openVsxTarget(platform = process.platform, arch = process.arch): string {
  const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  return `${os}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

export async function downloadOpenVsx(extensionId: string, fetchImpl: typeof fetch = fetch, directory = tmpdir()): Promise<string> {
  const [namespace, name] = extensionId.split('.');
  if (!namespace || !name || !/^[\w-]+$/.test(namespace) || !/^[\w-]+$/.test(name)) throw new Error(`Invalid extension id ${extensionId}.`);
  let download: string | undefined;
  for (const url of [`https://open-vsx.org/api/${namespace}/${name}/${openVsxTarget()}/latest`, `https://open-vsx.org/api/${namespace}/${name}/latest`]) {
    const response = await fetchImpl(url);
    if (!response.ok) continue;
    const info = await response.json() as { files?: { download?: unknown } };
    if (typeof info.files?.download === 'string' && info.files.download.startsWith('https://')) { download = info.files.download; break; }
  }
  if (!download) throw new Error(`${extensionId} was not found on Open VSX.`);
  const file = await fetchImpl(download);
  if (!file.ok) throw new Error(`Downloading ${extensionId} from Open VSX failed (${file.status}).`);
  await mkdir(directory, { recursive: true });
  const vsix = path.join(directory, `${extensionId}-${Date.now()}.vsix`);
  await writeFile(vsix, Buffer.from(await file.arrayBuffer()));
  return vsix;
}

/**
 * Install an extension from the editor's gallery, and when that fails for any reason (no gallery, or a gallery that
 * answers an error such as Open VSX's "Server returned 406" for some platform-specific manifests), install its VSIX
 * straight from Open VSX instead. Throws with both reasons when neither works.
 */
export async function installWithFallback(extensionId: string, fromGallery: (id: string) => Promise<unknown>, fromVsix: (file: string) => Promise<unknown>, download: (id: string) => Promise<string> = id => downloadOpenVsx(id), log?: (line: string) => void): Promise<'gallery' | 'open-vsx'> {
  let galleryError: unknown;
  try { await fromGallery(extensionId); return 'gallery'; }
  catch (error) { galleryError = error; log?.(`[heads] installing ${extensionId} from the gallery failed (${reason(error)}); trying Open VSX`); }
  try { await fromVsix(await download(extensionId)); return 'open-vsx'; }
  catch (error) { throw new Error(`Couldn't install ${extensionId}: the extension gallery said "${reason(galleryError)}", and Open VSX said "${reason(error)}".`); }
}
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);
