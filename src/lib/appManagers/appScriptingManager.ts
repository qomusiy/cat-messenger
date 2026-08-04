/*
 * Backs the script console's `tg.raw(...)` escape hatch.
 *
 * The curated `tg.*` surface in src/lib/scripting/api.ts covers the common
 * cases with nice ergonomics, but "everything Telegram can do" is ~500 MTProto
 * methods and hand-wrapping all of them is not a thing anyone should do. So the
 * console also lets a script name a method directly — and this manager is what
 * makes that legal: per AGENTS.md nothing outside a manager may touch
 * `apiManager.invokeApi*`, precisely because raw calls skip the side effects the
 * rest of the app depends on. Routing raw calls through here keeps them.
 *
 * `processRawResult` replays exactly the two side effects a hand-written manager
 * method would perform: save any peers that came back, and feed any `Updates`
 * into the update pipeline so the open UI reacts to what the script just did.
 */

import {AppManager} from '@appManagers/manager';
import type {MethodDeclMap} from '@layer';

/** MTProto methods a script may never reach — see `isForbiddenMethod`. */
const FORBIDDEN_PREFIXES = [
  'auth.',    // log-out / re-auth / export authorization (account takeover)
  'account.getPassword',
  'account.updatePasswordSettings',
  'account.resetPassword',
  'account.deleteAccount',
  'account.getAuthorizations',
  'account.resetAuthorization'
];

export default class AppScriptingManager extends AppManager {
  /**
   * A script naming a raw MTProto method. Refused for the credential surface:
   * a runaway script should be able to make a mess of messages, not to hand
   * over or destroy the account itself.
   */
  private isForbiddenMethod(method: string) {
    return FORBIDDEN_PREFIXES.some((prefix) => (
      prefix.endsWith('.') ? method.startsWith(prefix) : method === prefix
    ));
  }

  private processRawResult(result: any) {
    if(!result || typeof result !== 'object') return result;

    // Anything carrying `chats`/`users` — every *.get*, search and paged result.
    if(result.chats || result.users) {
      this.appPeersManager.saveApiPeers(result);
    }

    // Every Updates constructor is `update…` / `updates…`. Write methods return
    // these, and without dispatching them the sent message never appears in the
    // open chat until a reload.
    if(typeof result._ === 'string' && result._.startsWith('update')) {
      this.apiUpdatesManager.processUpdateMessage(result);
    }

    return result;
  }

  public invokeRaw(method: string, params: any = {}) {
    if(this.isForbiddenMethod(method)) {
      throw new Error(`${method} is not callable from a script (auth/credential surface)`);
    }

    return this.apiManager.invokeApiSingleProcess({
      method: method as keyof MethodDeclMap,
      params,
      processResult: (result) => this.processRawResult(result)
    });
  }

  /**
   * `InputPeer` / `InputChannel` / `InputUser` for a resolved peerId, so raw
   * calls can fill the peer argument every second MTProto method wants.
   */
  public getInputs(peerId: PeerId) {
    const inputPeer = this.appPeersManager.getInputPeerById(peerId);
    return {
      inputPeer,
      inputChannel: peerId.isAnyChat() && this.appChatsManager.isChannel(peerId.toChatId()) ?
        this.appChatsManager.getChannelInput(peerId.toChatId()) :
        undefined,
      inputUser: peerId.isUser() ? this.appUsersManager.getUserInput(peerId.toUserId()) : undefined
    };
  }
}
