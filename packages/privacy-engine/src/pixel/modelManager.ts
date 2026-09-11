import { loadPinnedModelSet, MODEL_MANIFEST, type FetchLike, type ModelManifest } from "../manifest";
import { ModelLoadFailedError } from "../sanitize";
import type { RuntimeProfile } from "../types";

export type PixelModelManager = {
  initialize(profile: RuntimeProfile): Promise<ReadonlyMap<string, ArrayBuffer>>;
  dispose(): void;
};

/**
 * Verifies and retains the model bytes for the lifetime of one scan session.
 * Worker creation is deliberately supplied by the extension: this package
 * remains usable in service workers and deterministic tests without assuming
 * a DOM Worker implementation.
 */
export function createPixelModelManager(
  manifest: ModelManifest = MODEL_MANIFEST,
  fetchImpl?: FetchLike,
): PixelModelManager {
  let loaded: ReadonlyMap<string, ArrayBuffer> | undefined;
  let initializing: Promise<ReadonlyMap<string, ArrayBuffer>> | undefined;

  return {
    async initialize(_profile) {
      if (loaded) return loaded;
      initializing ??= loadPinnedModelSet(manifest, fetchImpl).catch((error) => {
        initializing = undefined;
        throw new ModelLoadFailedError(error instanceof Error ? error.message : "Pinned pixel models could not be loaded.");
      });
      loaded = await initializing;
      return loaded;
    },
    dispose() {
      loaded = undefined;
      initializing = undefined;
    },
  };
}
