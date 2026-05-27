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
  esbuild.build({ ...shared, entryPoints: ["dev/bench.ts"], outfile: "dist/bench.js" }),
  esbuild.build({
    ...shared,
    entryPoints: ["dev/collect-textures.ts"],
    outfile: "dist/collect-textures.js",
  }),
  esbuild.build({ ...shared, entryPoints: ["dev/conv-time.ts"], outfile: "dist/conv-time.js" }),
]);
