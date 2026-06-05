import * as fs from "fs";
import * as path from "path";
import { isTocFile, parseToc } from "../../../src/parser/toc";

const LIVE = path.join(__dirname, "../../../_live/Addons");
const describeIfLive = fs.existsSync(LIVE) ? describe : describe.skip;

describe("isTocFile", () => {
  test("detects a valid TOC by ## Interface line", () => {
    expect(isTocFile("## Interface: 120000\nFoo.lua\n")).toBe(true);
  });

  test("returns false for plain Lua", () => {
    expect(isTocFile("local x = 1\n")).toBe(false);
  });

  test("is case-insensitive for Interface keyword", () => {
    expect(isTocFile("## interface: 90207\n")).toBe(true);
  });
});

describe("parseToc", () => {
  test("parses Interface versions as integers", () => {
    const toc = parseToc("## Interface: 120000, 50501, 11507\n");
    expect(toc.interfaceVersions).toEqual([120000, 50501, 11507]);
  });

  test("parses single Interface version", () => {
    const toc = parseToc("## Interface: 90207\n");
    expect(toc.interfaceVersions).toEqual([90207]);
  });

  test("extracts title", () => {
    const toc = parseToc("## Interface: 120000\n## Title: My Addon |cFF69CCF0by Author|r\n");
    expect(toc.title).toBe("My Addon |cFF69CCF0by Author|r");
  });

  test("title defaults to empty string when absent", () => {
    expect(parseToc("## Interface: 120000\n").title).toBe("");
  });

  test("extracts version", () => {
    const toc = parseToc("## Interface: 120000\n## Version: 1.2.3\n");
    expect(toc.version).toBe("1.2.3");
  });

  test("version is undefined when absent", () => {
    expect(parseToc("## Interface: 120000\n").version).toBeUndefined();
  });

  test("extracts savedVariables (comma-separated)", () => {
    const toc = parseToc("## Interface: 120000\n## SavedVariables: MyAddonDB, OtherDB\n");
    expect(toc.savedVariables).toEqual(["MyAddonDB", "OtherDB"]);
  });

  test("extracts savedVariablesPerCharacter", () => {
    const toc = parseToc("## Interface: 120000\n## SavedVariablesPerCharacter: CharDB\n");
    expect(toc.savedVariablesPerChar).toEqual(["CharDB"]);
  });

  test("savedVariables and savedVariablesPerChar are empty arrays when absent", () => {
    const toc = parseToc("## Interface: 120000\n");
    expect(toc.savedVariables).toEqual([]);
    expect(toc.savedVariablesPerChar).toEqual([]);
  });

  test("directive keys are case-insensitive", () => {
    const toc = parseToc("## interface: 90207\n## title: CasedTitle\n## version: 2.0\n");
    expect(toc.interfaceVersions).toEqual([90207]);
    expect(toc.title).toBe("CasedTitle");
    expect(toc.version).toBe("2.0");
  });

  test("rawMeta captures all directives including unknowns", () => {
    const content = "## Interface: 120000\n## Author: Someone\n## X-Custom: val\n";
    const toc = parseToc(content);
    expect(toc.rawMeta["Author"]).toBe("Someone");
    expect(toc.rawMeta["X-Custom"]).toBe("val");
  });

  test("collects lua and xml files with correct types", () => {
    const content = [
      "## Interface: 120000",
      "Libs\\LibStub\\LibStub.lua",
      "Core\\Init.lua",
      "MyAddon.xml",
    ].join("\n");
    const toc = parseToc(content);
    expect(toc.files).toEqual([
      { path: "Libs/LibStub/LibStub.lua", type: "lua" },
      { path: "Core/Init.lua", type: "lua" },
      { path: "MyAddon.xml", type: "xml" },
    ]);
  });

  test("normalises backslashes to forward slashes", () => {
    const toc = parseToc("Foo\\Bar\\Baz.lua\n");
    expect(toc.files[0]).toEqual({ path: "Foo/Bar/Baz.lua", type: "lua" });
  });

  test("ignores files with unrecognised extensions", () => {
    const toc = parseToc("## Interface: 120000\ndata.txt\nFoo.lua\n");
    expect(toc.files).toEqual([{ path: "Foo.lua", type: "lua" }]);
  });

  test("ignores single-# comment lines", () => {
    const content = "## Interface: 120000\n# This is a comment\nFoo.lua\n";
    const toc = parseToc(content);
    expect(toc.files).toEqual([{ path: "Foo.lua", type: "lua" }]);
  });

  test("ignores blank lines", () => {
    const content = "## Interface: 120000\n\n\nFoo.lua\n\nBar.xml\n";
    const toc = parseToc(content);
    expect(toc.files).toEqual([
      { path: "Foo.lua", type: "lua" },
      { path: "Bar.xml", type: "xml" },
    ]);
  });

  test("handles CRLF line endings", () => {
    const content = "## Interface: 120000\r\nFoo.lua\r\nBar.xml\r\n";
    const toc = parseToc(content);
    expect(toc.interfaceVersions).toEqual([120000]);
    expect(toc.files).toEqual([
      { path: "Foo.lua", type: "lua" },
      { path: "Bar.xml", type: "xml" },
    ]);
  });

  test("records sourceFile", () => {
    const toc = parseToc("## Interface: 120000\n", "/path/to/MyAddon.toc");
    expect(toc.sourceFile).toBe("/path/to/MyAddon.toc");
  });

  test("sourceFile defaults to empty string", () => {
    expect(parseToc("## Interface: 120000\n").sourceFile).toBe("");
  });
});

describeIfLive("parseToc — real fixtures (requires _live/)", () => {
  test("AddonFactory.toc", () => {
    const content = fs.readFileSync(path.join(LIVE, "AddonFactory/AddonFactory.toc"), "utf8");
    const toc = parseToc(content);
    expect(toc.interfaceVersions).toEqual([120000, 50501, 11507]);
    expect(toc.title).toContain("AddonFactory");
    expect(toc.files.map((f) => f.path)).toContain("AddonFactory.xml");
    expect(toc.files[0]).toEqual({ path: "Libs/LibStub/LibStub.lua", type: "lua" });
  });

  test("ExampleControlButton.toc", () => {
    const content = fs.readFileSync(
      path.join(LIVE, "ExampleControlButton__Vertex/ExampleControlButton__Vertex.toc"),
      "utf8",
    );
    const toc = parseToc(content);
    expect(toc.interfaceVersions).toEqual([110205, 110207, 120000]);
    expect(toc.files).toEqual([
      { path: "ExampleControlButton.lua", type: "lua" },
      { path: "ExampleControlButton.xml", type: "xml" },
      { path: "_harness.lua", type: "lua" },
    ]);
  });
});
