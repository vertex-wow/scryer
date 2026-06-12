import * as fs from "fs";
import * as path from "path";
import { shutdownAssetClient } from "../../src/assets/extract-core";
import { getExtractedAssetsDir } from "../unit-casc/helpers";

function resolveChildCI(parent: string, name: string): string | null {
  const lower = name.toLowerCase();
  try {
    const match = fs.readdirSync(parent).find((e) => e.toLowerCase() === lower);
    return match ? path.join(parent, match) : null;
  } catch {
    return null;
  }
}

export default function (): () => Promise<void> {
  const assetsDir = getExtractedAssetsDir();
  if (!assetsDir) {
    throw new Error("CASC not configured: set scryer.cacheDir in dev/settings.local.json");
  }
  const interfaceDir = resolveChildCI(assetsDir, "Interface");
  const addonsDir = interfaceDir ? resolveChildCI(interfaceDir, "AddOns") : null;
  if (!addonsDir || !resolveChildCI(addonsDir, "Blizzard_SharedXML")) {
    throw new Error(
      `CASC Blizzard addons not extracted: Blizzard_SharedXML not found under ${path.join(assetsDir, "Interface", "AddOns")}`,
    );
  }
  return shutdownAssetClient;
}
