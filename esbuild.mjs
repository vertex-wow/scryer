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

// Webview bundle (browser IIFE, no Node/vscode APIs)
const webviewCtx = await esbuild.context({
  ...shared,
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
});

if (watch) {
  await extensionCtx.watch();
  await webviewCtx.watch();
  console.log("Watching...");
} else {
  await extensionCtx.rebuild();
  await extensionCtx.dispose();
  await webviewCtx.rebuild();
  await webviewCtx.dispose();
  console.log("Build complete.");
}
