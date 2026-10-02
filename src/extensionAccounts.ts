import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { AccountState } from './core/accountSetup';
import type { Provider } from './core/model';
import { AccountsService } from './host/accounts';
import { VsCodeHost } from './vscodeHost';

/** The IDE's Accounts panel over src/host/accounts.ts's AccountsService. */
export class ProviderAccounts implements vscode.Disposable {
  private panel?:vscode.WebviewPanel;
  /** The sign-in state and flows themselves. */
  readonly service:AccountsService;
  private readonly updates:vscode.Disposable;
  constructor(context:vscode.ExtensionContext,private readonly available:boolean){
    this.service=new AccountsService(new VsCodeHost(context,{appendLine:()=>undefined},()=>undefined),available);
    this.updates=this.service.onUpdate(states=>{void this.panel?.webview.postMessage({type:'accounts',states});});
  }
  snapshot():Record<Provider,AccountState>{return this.service.snapshot();}
  private update(provider:Provider,state:AccountState):void{this.service.update(provider,state);}
  show(focus?:Provider,autoLogin?:boolean):void{
    if(!this.available)throw new Error('Account setup is available in the local Hydra desktop IDE.');
    // Check the provider's own reported status first: an already signed-in
    // account needs no sign-in flow, so Claude's CLI terminal is never opened
    // for an account that is already connected.
    const startLogin=(provider:Provider)=>{void (async()=>{
      await this.action(provider,'refresh');
      if(this.service.snapshot()[provider].status==='signed-in')return;
      await this.action(provider,'login');
    })().catch(()=>this.update(provider,{status:'error',text:'Use account setup in your trusted local Hydra window.'}));};
    if(this.panel){
      this.panel.reveal();
      if(focus==='claude'||focus==='codex'){
        void this.panel.webview.postMessage({type:'focus',provider:focus});
        if(autoLogin)startLogin(focus);
      }
      return;
    }
    const panel=vscode.window.createWebviewPanel('hydra.accounts','Hydra · Accounts',vscode.ViewColumn.Active,{enableScripts:true});this.panel=panel;
    panel.webview.html=this.html();panel.onDidDispose(()=>{if(this.panel===panel)this.panel=undefined;});
    panel.webview.onDidReceiveMessage((value:unknown)=>{
      if(!value||typeof value!=='object')return;const message=value as Record<string,unknown>;
      if(message.type==='ready'){
        void panel.webview.postMessage({type:'accounts',states:this.snapshot()});
        if(focus==='claude'||focus==='codex'){
          void panel.webview.postMessage({type:'focus',provider:focus});
          if(autoLogin)startLogin(focus);
        }
        return;
      }
      if((message.provider==='claude'||message.provider==='codex')&&['login','refresh','cancel','guide'].includes(String(message.type))){const provider=message.provider;void this.action(provider,message.type as 'login'|'refresh'|'cancel'|'guide').catch(()=>this.update(provider,{status:'error',text:'Use account setup in your trusted local Hydra window.'}));}
    });
  }
  action(provider:Provider,action:'login'|'refresh'|'cancel'|'guide'):Promise<void>{return this.service.action(provider,action);}
  shutdown():Promise<void>{return this.service.shutdown();}
  dispose():void{this.updates.dispose();this.panel?.dispose();this.service.dispose();}
  private html():string{
    const nonce=randomBytes(24).toString('base64');
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'nonce-${nonce}';script-src 'nonce-${nonce}'"><style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0}main{max-width:700px;margin:0 auto;padding:44px 30px}header{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:24px;font-size:12px;letter-spacing:.13em}h1{font-size:32px;font-weight:550;letter-spacing:-.035em;margin-top:34px}p{line-height:1.7;color:var(--vscode-descriptionForeground)}article{border-top:1px solid var(--vscode-panel-border);padding:24px 0}h2{font-size:18px;font-weight:550;margin:0}button{font:inherit;cursor:pointer;padding:9px 13px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{opacity:.5;cursor:default}.actions{display:flex;flex-wrap:wrap;gap:10px}.status{min-height:44px;white-space:pre-wrap}[hidden]{display:none!important}button{background:#ececec;color:#3a3a3a;border-color:#e0e0e0}button:hover{background:#e0e0e0}button.primary{background:#e4e4e4;color:#2a2a2a;font-weight:600}</style></head><body><main><header>HYDRA / ACCOUNTS</header><h1>Your providers. Their sign-in.</h1><p>Sign in with your subscription through the official installed tools. Credentials stay with the provider. Opening this page does not contact an account or start a model.</p>
    ${(['claude','codex'] as const).map(provider=>`<article data-provider="${provider}"><h2>${provider==='claude'?'Claude Code':'OpenAI Codex'}</h2><p>${provider==='claude'?'Claude Code 2.1.270 or newer · Opens the official CLI sign-in terminal':'Codex 0.154.0 or newer · Opens its ChatGPT sign-in page'}</p><p class="status" role="status"></p><div class="actions"><button class="primary" data-action="login">${provider==='claude'?'Sign in to Claude Code':'Sign in with ChatGPT'}</button><button data-action="refresh">Refresh status</button><button data-action="cancel" hidden>Cancel setup</button><button data-action="guide">Install / setup guide ↗</button></div></article>`).join('')}
    <p>Cancel stops Hydra’s local setup attempt; it does not revoke a completed sign-in. Manage account sign-out in the official provider client. A reported sign-in does not guarantee subscription eligibility or model access.</p></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('article').forEach(card=>card.querySelectorAll('button').forEach(button=>button.onclick=()=>vscode.postMessage({type:button.dataset.action,provider:card.dataset.provider})));window.addEventListener('message',event=>{if(event.data.type==='focus'){const card=document.querySelector('[data-provider="'+event.data.provider+'"]');const button=card&&card.querySelector('[data-action=login]');if(button){card.scrollIntoView({block:'center'});button.focus();}return;}if(event.data.type!=='accounts')return;for(const [provider,state]of Object.entries(event.data.states)){const card=document.querySelector('[data-provider="'+provider+'"]');if(!card)continue;card.querySelector('.status').textContent=state.text;const active=['working','pending'].includes(state.status);card.querySelector('[data-action=login]').disabled=active;card.querySelector('[data-action=refresh]').disabled=active;card.querySelector('[data-action=cancel]').hidden=!active;}});vscode.postMessage({type:'ready'});</script></body></html>`;
  }
}
