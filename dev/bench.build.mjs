// Builds dev/bench.ts into dist/bench.js using the same esbuild config as the
// extension host bundle (CJS, Node platform, vscode external).
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["dev/bench.ts"],
  outfile: "dist/bench.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  target: "node20",
  sourcemap: false,
});
