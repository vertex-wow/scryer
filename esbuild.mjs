import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  sourcemap: true,
  minify: false,
};

// Extension host bundle (Node / CommonJS, vscode is external)
const extensionCtx = await esbuild.context({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  external: ["vscode"],
  target: "node20",
});

if (watch) {
  await extensionCtx.watch();
  console.log("Watching...");
} else {
  await extensionCtx.rebuild();
  await extensionCtx.dispose();
  console.log("Build complete.");
}
