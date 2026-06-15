import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readAssetBytes,
  shutdownAssetClient,
  type ExtractCoreOptions,
} from "../../../src/assets/extract-core.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(
  flavor: "retail" | "classic" | "classic_era",
  overrides: Partial<ExtractCoreOptions> = {},
): ExtractCoreOptions {
  return {
    flavor,
    outDir: "/tmp/out",
    wowDir: "/tmp/wow",
    assetServerPath: "/tmp/server",
    assetServerIdleTimeout: 20,
    listfileDir: "/tmp/list",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readAssetBytes — flavor gate
// ---------------------------------------------------------------------------

describe("readAssetBytes — non-retail short-circuit", () => {
  afterEach(async () => {
    await shutdownAssetClient();
  });

  it("returns null for classic without starting a server", async () => {
    const result = await readAssetBytes("dbfilesclient/uitextureatlas.db2", makeOpts("classic"));
    expect(result).toBeNull();
  });

  it("returns null for classic_era without starting a server", async () => {
    const result = await readAssetBytes(
      "dbfilesclient/uitextureatlasmember.db2",
      makeOpts("classic_era"),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readAssetBytes — retail path (mocked AssetClient)
// ---------------------------------------------------------------------------

const mockReadFileBytes = vi.hoisted(() => vi.fn<[string, boolean], Promise<Buffer | null>>());

vi.mock("../../../src/assets/asset-client.js", () => ({
  AssetClient: vi.fn().mockImplementation(function () {
    return {
      readFileBytes: mockReadFileBytes,
      acquireKeepalive: vi.fn(),
      releaseKeepalive: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

describe("readAssetBytes — retail", () => {
  afterEach(async () => {
    await shutdownAssetClient();
  });

  it("returns bytes from client.readFileBytes on hit", async () => {
    const expected = Buffer.from("WDC4_header_bytes");
    mockReadFileBytes.mockResolvedValueOnce(expected);

    const result = await readAssetBytes("dbfilesclient/uitextureatlas.db2", makeOpts("retail"));

    expect(result).toEqual(expected);
    expect(mockReadFileBytes).toHaveBeenCalledWith("dbfilesclient/uitextureatlas.db2", false);
  });

  it("returns null when client.readFileBytes returns null (miss)", async () => {
    mockReadFileBytes.mockResolvedValueOnce(null);

    const result = await readAssetBytes("dbfilesclient/missing.db2", makeOpts("retail"));
    expect(result).toBeNull();
  });

  it("returns null when client.readFileBytes throws", async () => {
    mockReadFileBytes.mockRejectedValueOnce(new Error("server unavailable"));

    const result = await readAssetBytes("dbfilesclient/uitextureatlas.db2", makeOpts("retail"));
    expect(result).toBeNull();
  });

  it("forwards cdnEnabled from opts", async () => {
    mockReadFileBytes.mockResolvedValueOnce(null);

    await readAssetBytes(
      "dbfilesclient/uitextureatlas.db2",
      makeOpts("retail", { cdnEnabled: true }),
    );

    expect(mockReadFileBytes).toHaveBeenCalledWith("dbfilesclient/uitextureatlas.db2", true);
  });
});
