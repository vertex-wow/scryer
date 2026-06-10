/**
 * CDN fallback net tests — require a WoW install AND outbound network access.
 *
 * These are NOT run in CI. Run manually when troubleshooting CDN behaviour or
 * verifying a fresh build against a real install:
 *
 *   pnpm test:net
 *
 * Prerequisites:
 *   - dev/settings.local.json with scryer.installDir pointing at your WoW dir
 *   - pnpm build must have been run (binary at scryer-asset-server/target/release/)
 *
 * The test runs each probe path twice — once without CDN and once with — so the
 * output shows exactly what was locally available vs fetched from Blizzard's CDN.
 */

import { AssetClient } from "../../src/assets/asset-client";
import { getNetTestEnv } from "./helpers";

// Three Blizzard interface files confirmed as CDN-only stubs on default Battle.net
// installs (present in the CASC index but not downloaded locally). Paths are
// lowercase to match the community listfile format; extraction is case-insensitive.
const PROBE_PATHS = [
  "interface/addons/blizzard_sharedxml/portraitframe.lua",
  "interface/addons/blizzard_sharedxml/sortutil.lua",
  "interface/addons/blizzard_sharedxml/buttongroup.lua",
];

const env = getNetTestEnv();
const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

describeIf(env !== null)("CDN fallback — live network", () => {
  let client: AssetClient;

  beforeAll(() => {
    client = new AssetClient({
      binaryPath: env!.binaryPath,
      wowDir: env!.wowDir,
      outDir: env!.outDir,
      idleTimeout: 120,
      log: (level, msg, time) => {
        // Surface warn/error lines so failures are visible in test output.
        if (level === "warn" || level === "error") {
          console.log(`  [${time ?? "--:--:--"}] ${level.toUpperCase()} ${msg}`);
        }
      },
    });
  });

  afterAll(async () => {
    await client.shutdown();
  });

  test(
    "CDN fills in files unavailable locally",
    async () => {
      // ── Pass 1: no CDN ────────────────────────────────────────────────────
      const noCdn = await client.extractFiles(PROBE_PATHS, /* cdnEnabled */ false);

      console.log("\n  Pass 1 (no CDN):");
      console.log(`    extracted:   ${noCdn.extracted}`);
      console.log(`    unavailable: ${noCdn.unavailable}`);
      console.log(`    errors:      ${noCdn.errors}`);

      expect(noCdn.errors).toBe(0);

      if (noCdn.unavailable === 0) {
        console.log(
          "\n  All probe files available locally — CDN path not exercised on this install.",
        );
        // Still a valid result; nothing to assert about CDN.
        return;
      }

      // ── Pass 2: CDN enabled ───────────────────────────────────────────────
      const withCdn = await client.extractFiles(PROBE_PATHS, /* cdnEnabled */ true);

      console.log("\n  Pass 2 (CDN enabled):");
      console.log(`    extracted:   ${withCdn.extracted}`);
      console.log(`    unavailable: ${withCdn.unavailable}`);
      console.log(`    errors:      ${withCdn.errors}`);

      expect(withCdn.errors).toBe(0);
      expect(withCdn.unavailable).toBe(0);
    },
    // 3-minute ceiling: server startup (~45s) + archive index load + CDN fetches.
    3 * 60 * 1000,
  );
});
