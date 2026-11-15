import { createCompletion, MODEL } from './engine.js';
import { browserStore } from './store.js';

/** Browser-only SDK. Uses the same local ledger as the service worker API. */
export class RelayClient {
  constructor() {
    this.chat = { completions: { create: (body, { onProgress } = {}) => createCompletion(body, browserStore, { onProgress }) } };
  }
  balance() { return browserStore.read(); }
}
export { MODEL };
export { RelayClient as TalkingTom };
