/**
 * Local browser provider (dev). The worker launches local Chrome itself when cdpUrl is null,
 * so there is nothing to create here: no CDP URL, no live view, no recording.
 */
import type { BrowserProvider } from "../core/contracts.js";

export function createLocalBrowserProvider(): BrowserProvider {
  return {
    name: "local",
    async createSession({ attemptId, onEvent }) {
      onEvent("Using local browser (dev mode)", { provider: "local", attemptId });
      return {
        id: `local_${attemptId}`,
        provider: "local",
        cdpUrl: null,
        liveViewUrl: null,
        async close() {},
        async getRecordingUrl() {
          return null;
        },
      };
    },
  };
}
