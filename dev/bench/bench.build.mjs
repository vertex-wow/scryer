// Builds dev scripts into dist/ using the same esbuild config as the
// extension host bundle (CJS, Node platform, vscode external).
import * as esbuild from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  target: "node20",
  sourcemap: false,
};

await Promise.all([
  esbuild.build({ ...shared, entryPoints: ["dev/bench/bench.ts"], outfile: "dist/bench.js" }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/tools/collect-textures.ts"],
    outfile: "dist/collect-textures.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/tools/conv-time.ts"],
    outfile: "dist/conv-time.js",
  }),
  esbuild.build({ ...shared, entryPoints: ["dev/gen-atlas.ts"], outfile: "dist/gen-atlas.js" }),
  esbuild.build({ ...shared, entryPoints: ["dev/extract.ts"], outfile: "dist/extract.js" }),
  esbuild.build({ ...shared, entryPoints: ["dev/links.ts"], outfile: "dist/links.js" }),
  esbuild.build({ ...shared, entryPoints: ["dev/assets.ts"], outfile: "dist/assets.js" }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/gen-globalstrings.ts"],
    outfile: "dist/gen-globalstrings.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/gen-api-stubs.ts"],
    outfile: "dist/gen-api-stubs.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/tools/png-to-blp.ts"],
    outfile: "dist/png-to-blp.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/tools/scan-corpus.ts"],
    outfile: "dist/scan-corpus.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/bench/bench-tga-decoder.ts"],
    outfile: "dist/bench-tga.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/bench/bench-atlas-gen.ts"],
    outfile: "dist/bench-atlas-gen.js",
  }),
]);
