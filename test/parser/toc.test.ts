import * as fs from "fs";
import * as path from "path";
import { parseToc } from "../../src/parser/toc";

const LIVE = path.join(__dirname, "../../_live/Addons");

describe("parseToc", () => {
  test("parses Interface versions as integers", () => {
    const toc = parseToc("## Interface: 120000, 50501, 11507\n");
    expect(toc.interfaceVersions).toEqual([120000, 50501, 11507]);
  });

  test("parses single Interface version", () => {
    const toc = parseToc("## Interface: 90207\n");
    expect(toc.interfaceVersions).toEqual([90207]);
  });

  test("populates metadata map", () => {
    const content = [
      "## Interface: 120000",
      "## Title: My Addon",
      "## Version: 1.2.3",
      "## Author: Someone",
    ].join("\n");
    const toc = parseToc(content);
    expect(toc.metadata["Title"]).toBe("My Addon");
    expect(toc.metadata["Version"]).toBe("1.2.3");
    expect(toc.metadata["Author"]).toBe("Someone");
  });

  test("collects file paths in order", () => {
    const content = [
      "## Interface: 120000",
      "Libs\\LibStub\\LibStub.lua",
      "Core\\Init.lua",
      "MyAddon.xml",
    ].join("\n");
    const toc = parseToc(content);
    expect(toc.files).toEqual(["Libs/LibStub/LibStub.lua", "Core/Init.lua", "MyAddon.xml"]);
  });

  test("normalises backslashes to forward slashes", () => {
    const toc = parseToc("Foo\\Bar\\Baz.lua\n");
    expect(toc.files[0]).toBe("Foo/Bar/Baz.lua");
  });

  test("ignores single-# comment lines", () => {
    const content = "## Interface: 120000\n# This is a comment\nFoo.lua\n";
    const toc = parseToc(content);
    expect(toc.files).toEqual(["Foo.lua"]);
  });

  test("ignores blank lines", () => {
    const content = "## Interface: 120000\n\n\nFoo.lua\n\nBar.lua\n";
    const toc = parseToc(content);
    expect(toc.files).toEqual(["Foo.lua", "Bar.lua"]);
  });

  test("handles CRLF line endings", () => {
    const content = "## Interface: 120000\r\nFoo.lua\r\nBar.lua\r\n";
    const toc = parseToc(content);
    expect(toc.interfaceVersions).toEqual([120000]);
    expect(toc.files).toEqual(["Foo.lua", "Bar.lua"]);
  });

  test("AddonFactory.toc — real fixture", () => {
    const content = fs.readFileSync(path.join(LIVE, "AddonFactory/AddonFactory.toc"), "utf8");
    const toc = parseToc(content);
    expect(toc.interfaceVersions).toEqual([120000, 50501, 11507]);
    expect(toc.metadata["Title"]).toContain("AddonFactory");
    expect(toc.files).toContain("AddonFactory.xml");
    expect(toc.files[0]).toBe("Libs/LibStub/LibStub.lua");
  });

  test("ExampleControlButton.toc — real fixture", () => {
    const content = fs.readFileSync(
      path.join(LIVE, "ExampleControlButton__Vertex/ExampleControlButton__Vertex.toc"),
      "utf8",
    );
    const toc = parseToc(content);
    expect(toc.interfaceVersions).toEqual([110205, 110207, 120000]);
    expect(toc.files).toEqual([
      "ExampleControlButton.lua",
      "ExampleControlButton.xml",
      "_harness.lua",
    ]);
  });
});
