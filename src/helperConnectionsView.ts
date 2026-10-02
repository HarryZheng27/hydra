import type { ProviderConnectionView } from './core/model';
export type { ProviderConnectionView };

/** Runs one of Hydra's commands by id (Host.command, or the IDE's executeCommand). */
export type CommandRunner = <T = unknown>(id: string, ...args: unknown[]) => Thenable<T>;

/** Handle one connections message from a webview. Returns true when the message was ours. */
export async function handleConnectionsMessage(message: Record<string, unknown>, post: (value: unknown) => Thenable<boolean>, command: CommandRunner): Promise<boolean> {
  const provider = message.provider === 'claude' || message.provider === 'codex' ? message.provider : undefined;
  let text = '';
  switch (message.type) {
    case 'connections': break;
    case 'connectHelpers': {
      if (!provider) throw new Error('Unknown provider.');
      const result = await command<{ warning?: string }>('hydra.connectHelpers', provider);
      text = result?.warning || `${provider === 'claude' ? 'Claude Code' : 'Codex'} is connected to Hydra. New ${provider === 'claude' ? 'Claude' : 'Codex'} chats can start Hydra heads.`; break;
    }
    case 'disconnectHelpers':
      if (!provider) throw new Error('Unknown provider.');
      await command('hydra.disconnectHelpers', provider);
      text = `${provider === 'claude' ? 'Claude Code' : 'Codex'} is disconnected from Hydra.`; break;
    case 'signIn':
      if (!provider) throw new Error('Unknown provider.');
      await command('hydra.openAccounts', provider, true);
      text = 'Starting sign-in.'; break;
    default: return false;
  }
  const connections = await command<ProviderConnectionView[]>('hydra.helperConnections');
  await post({ type: 'connections', connections, text });
  return true;
}

export function connectionsSection(marks: { claude: string; codex: string }): string {
  const row = (provider: 'claude' | 'codex', name: string, blurb: string) => `<div class="card connection" data-connection="${provider}"><h2>${marks[provider]}${name}</h2><p>${blurb}</p><p class="connection-state" data-state="${provider}">Checking…</p><div class="actions"><button class="primary" data-connect="${provider}" hidden>Connect to Hydra</button><button data-disconnect="${provider}" hidden>Disconnect</button><button class="quiet" data-signin="${provider}">Sign in</button></div></div>`;
  return `<div class="cards">${row('claude', 'Claude Code', 'Chat in the Claude Code extension. Claude can start Hydra heads for independent work. Memory (claude-mem) is optional, in Settings → Connectors.')}${row('codex', 'Codex', 'Chat in the Codex extension. Codex can start Hydra heads for independent work.')}</div><p class="connection-note">Connect installs the extension if needed and adds Hydra as a tool in its user settings on this computer — never inside a project. Claude Code and Codex keep their own sign-in and billing, and you can disconnect anytime.</p>`;
}

/** Client script: expects `send(message)` and a `status` element in scope. */
export const connectionsScript = `
function renderConnections(list){for(const c of list||[]){const state=document.querySelector('[data-state="'+c.provider+'"]');if(!state)continue;
const memory=c.memory===undefined?'':c.memory==='ready'?' Memory: claude-mem on.':' Memory: claude-mem not set up yet.';
state.textContent=c.error?('Error: '+c.error):!c.connected?(c.extensionInstalled?'Not connected to Hydra.':'Not installed. Connect installs it and connects it to Hydra.'):(c.current?'Connected to Hydra.':c.development?'Connected to another Hydra. A development window leaves it as it is.':'Connected, updating for this Hydra…')+(c.connected?memory:'');
document.querySelector('[data-connect="'+c.provider+'"]').hidden=c.connected&&c.current&&c.memory!=='missing';
document.querySelector('[data-disconnect="'+c.provider+'"]').hidden=!c.connected;}}
document.querySelectorAll('[data-connect]').forEach(b=>b.addEventListener('click',()=>send({type:'connectHelpers',provider:b.dataset.connect})));
document.querySelectorAll('[data-disconnect]').forEach(b=>b.addEventListener('click',()=>send({type:'disconnectHelpers',provider:b.dataset.disconnect})));
document.querySelectorAll('[data-signin]').forEach(b=>b.addEventListener('click',()=>send({type:'signIn',provider:b.dataset.signin})));
`;
