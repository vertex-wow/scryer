import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  clearFlavorCache,
  FLAVOR_INFO,
  flavorProduct,
  flavorSubdir,
  parseBuildInfo,
  readBuildStamp,
  readBuildText,
  writeBuildStamp,
} from "../../src/assets/build-info";

// Minimal realistic .build.info content (pipe-delimited, two products).
const SAMPLE_BUILD_INFO = [
  "Branch!STRING:0|Active!DEC:1|BuildConfig!HEX:16|CDNConfig!HEX:16|KeyRing!HEX:16|Region!STRING:0|BuildId!DEC:4|VersionsName!STRING:0|Product!STRING:0|Tags!STRING:0|Armory!STRING:0|Version!STRING:0",
  "wow_classic_era||abc|def||us|12345|1.15.3.55000|wow_classic_era|enUS|0|1.15.3.55000",
  "wow||111|222||us|60000|11.1.7.60000|wow|enUS|0|11.1.7.60000",
  "wow_classic||333|444||us|56789|1.15.7.56789|wow_classic|enUS|0|1.15.7.56789",
].join("\n");

// Same content with CRLF line endings.
const SAMPLE_CRLF = SAMPLE_BUILD_INFO.replace(/\n/g, "\r\n");

// Content using "BuildText" column name instead of "Version".
const SAMPLE_BUILDTEXT_COL = [
  "Product!STRING:0|BuildText!STRING:0",
  "wow|11.1.7.60000",
  "wow_classic|1.15.7.56789",
].join("\n");

describe("FLAVOR_INFO", () => {
  it("covers all three flavors", () => {
    expect(Object.keys(FLAVOR_INFO)).toEqual(
      expect.arrayContaining(["retail", "classic", "classic_era"]),
    );
  });
});

describe("flavorSubdir", () => {
  it("maps retail → _retail_", () => expect(flavorSubdir("retail")).toBe("_retail_"));
  it("maps classic → _classic_", () => expect(flavorSubdir("classic")).toBe("_classic_"));
  it("maps classic_era → _classic_era_", () =>
    expect(flavorSubdir("classic_era")).toBe("_classic_era_"));
  it("falls back to _retail_ for unknown flavor", () =>
    expect(flavorSubdir("unknown")).toBe("_retail_"));
});

describe("flavorProduct", () => {
  it("maps retail → wow", () => expect(flavorProduct("retail")).toBe("wow"));
  it("maps classic → wow_classic", () => expect(flavorProduct("classic")).toBe("wow_classic"));
  it("maps classic_era → wow_classic_era", () =>
    expect(flavorProduct("classic_era")).toBe("wow_classic_era"));
  it("falls back to wow for unknown flavor", () => expect(flavorProduct("unknown")).toBe("wow"));
});

describe("parseBuildInfo", () => {
  it("parses all three products from a realistic file", () => {
    const map = parseBuildInfo(SAMPLE_BUILD_INFO);
    expect(map.get("wow")).toBe("11.1.7.60000");
    expect(map.get("wow_classic")).toBe("1.15.7.56789");
    expect(map.get("wow_classic_era")).toBe("1.15.3.55000");
  });

  it("handles CRLF line endings", () => {
    const map = parseBuildInfo(SAMPLE_CRLF);
    expect(map.get("wow")).toBe("11.1.7.60000");
  });

  it("accepts BuildText as the version column name", () => {
    const map = parseBuildInfo(SAMPLE_BUILDTEXT_COL);
    expect(map.get("wow")).toBe("11.1.7.60000");
    expect(map.get("wow_classic")).toBe("1.15.7.56789");
  });

  it("returns empty map for empty string", () => {
    expect(parseBuildInfo("").size).toBe(0);
  });

  it("returns empty map for header-only content", () => {
    expect(parseBuildInfo(SAMPLE_BUILD_INFO.split("\n")[0]).size).toBe(0);
  });

  it("returns empty map when Product column is absent", () => {
    const noProduct = "Branch!STRING:0|Version!STRING:0\nwow_main|11.1.7";
    expect(parseBuildInfo(noProduct).size).toBe(0);
  });

  it("returns empty map when version column is absent", () => {
    const noVersion = "Product!STRING:0|Branch!STRING:0\nwow|main";
    expect(parseBuildInfo(noVersion).size).toBe(0);
  });

  it("skips malformed rows without throwing", () => {
    const withBadRow = SAMPLE_BUILD_INFO + "\nbad_row_only_one_cell";
    expect(() => parseBuildInfo(withBadRow)).not.toThrow();
    const map = parseBuildInfo(withBadRow);
    expect(map.get("wow")).toBe("11.1.7.60000");
  });
});

describe("readBuildText", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scryer-buildinfo-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns BuildText for the configured flavor's product", () => {
    fs.writeFileSync(path.join(tmpDir, ".build.info"), SAMPLE_BUILD_INFO, "utf8");
    expect(readBuildText(tmpDir, "retail")).toBe("11.1.7.60000");
    expect(readBuildText(tmpDir, "classic")).toBe("1.15.7.56789");
    expect(readBuildText(tmpDir, "classic_era")).toBe("1.15.3.55000");
  });

  it("returns null when .build.info is absent", () => {
    expect(readBuildText(tmpDir, "retail")).toBeNull();
  });

  it("returns null when the product is not in the file", () => {
    const onlyClassic = "Product!STRING:0|Version!STRING:0\nwow_classic|1.15.7.56789\n";
    fs.writeFileSync(path.join(tmpDir, ".build.info"), onlyClassic, "utf8");
    expect(readBuildText(tmpDir, "retail")).toBeNull();
  });
});

describe("readBuildStamp / writeBuildStamp round-trip", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scryer-stamp-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns null when stamp is absent", () => {
    expect(readBuildStamp(tmpDir, "retail")).toBeNull();
  });

  it("round-trips a version string", () => {
    writeBuildStamp(tmpDir, "retail", "11.1.7.60000");
    expect(readBuildStamp(tmpDir, "retail")).toBe("11.1.7.60000");
  });

  it("creates the flavor directory if missing", () => {
    writeBuildStamp(tmpDir, "classic", "1.15.7.56789");
    expect(fs.existsSync(path.join(tmpDir, "classic", ".build-stamp"))).toBe(true);
  });

  it("stamps for different flavors are independent", () => {
    writeBuildStamp(tmpDir, "retail", "11.1.7.60000");
    writeBuildStamp(tmpDir, "classic", "1.15.7.56789");
    expect(readBuildStamp(tmpDir, "retail")).toBe("11.1.7.60000");
    expect(readBuildStamp(tmpDir, "classic")).toBe("1.15.7.56789");
  });
});

describe("clearFlavorCache", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scryer-clear-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("deletes only the targeted flavor subtree", () => {
    // Set up two flavor dirs with files.
    const retailSrc = path.join(tmpDir, "retail", "source");
    const classicSrc = path.join(tmpDir, "classic", "source");
    fs.mkdirSync(retailSrc, { recursive: true });
    fs.mkdirSync(classicSrc, { recursive: true });
    fs.writeFileSync(path.join(retailSrc, "x.png"), "");
    fs.writeFileSync(path.join(classicSrc, "y.png"), "");

    clearFlavorCache(tmpDir, "retail");

    expect(fs.existsSync(path.join(tmpDir, "retail"))).toBe(false);
    expect(fs.existsSync(path.join(classicSrc, "y.png"))).toBe(true);
  });

  it("does not throw when the flavor dir does not exist", () => {
    expect(() => clearFlavorCache(tmpDir, "classic_era")).not.toThrow();
  });
});
