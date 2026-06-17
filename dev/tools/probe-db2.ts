import * as fs from "fs";
import { readAssetBytes, shutdownAssetClient } from "../../src/assets/extract-core.js";

const REPO_ROOT = __dirname + "/../..";
const cfg = JSON.parse(fs.readFileSync(REPO_ROOT + "/dev/settings.local.json", "utf8")) as Record<
  string,
  string
>;

const coreOpts = {
  flavor: "retail" as const,
  outDir: cfg["scryer.cacheDir"] + "/retail/source",
  wowDir: cfg["scryer.installDir"],
  assetServerPath: cfg["scryer.assetServerPath"],
  assetServerIdleTimeout: 30,
  cdnEnabled: true,
  log: (level: string, msg: string, t?: string) => {
    console.log(`[server ${level}]${t ? " " + t : ""} ${msg}`);
  },
};

console.log("outDir:", coreOpts.outDir);
console.log("wowDir:", coreOpts.wowDir);

async function run() {
  for (const path of [
    "dbfilesclient/uitextureatlas.db2",
    "dbfilesclient/uitextureatlasмember.db2".replace("м", "m"),
  ]) {
    try {
      const buf = await readAssetBytes(path, coreOpts);
      if (buf) {
        console.log(
          `SUCCESS ${path}: ${buf.length} bytes, magic=0x${buf.readUInt32LE(0).toString(16)}`,
        );
      } else {
        console.log(`MISS ${path}`);
      }
    } catch (e: unknown) {
      console.error(`Error ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await shutdownAssetClient();
}

run();
