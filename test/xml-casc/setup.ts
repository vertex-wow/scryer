import { shutdownAssetClient } from "../../src/assets/extract-core";
import { getExtractedAssetsDir } from "../unit-casc/helpers";

export default function (): () => Promise<void> {
  const dir = getExtractedAssetsDir();
  if (!dir) {
    throw new Error(
      "CASC not configured: set scryer.cacheDir (and optionally scryer.flavor) in dev/settings.local.json",
    );
  }
  return shutdownAssetClient;
}
