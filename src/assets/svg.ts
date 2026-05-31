import * as cp from "child_process";
import * as path from "path";

function probe(cmd: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  return cp.spawnSync(which, [cmd], { stdio: "pipe" }).status === 0;
}

function spawn(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(cmd, args, { stdio: "pipe" });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
    proc.on("error", reject);
  });
}

/** Opaque handle for the flip tool resolved by resolveFlipTool(). */
export interface FlipTool {
  cmd: string;
  flavor: "gm" | "convert";
}

/** Returns true if rsvg-convert is available on PATH. */
export function isSvgConverterAvailable(): boolean {
  return probe("rsvg-convert");
}

/**
 * Resolve the PNG→TGA flip tool.
 * If explicitPath is provided it is used as-is; flavor is inferred from the basename
 * (anything named "gm" uses GraphicsMagick subcommand syntax; everything else uses
 * ImageMagick syntax). When omitted, auto-detects gm then convert from PATH.
 * Returns null if no usable tool is found.
 */
export function resolveFlipTool(explicitPath?: string): FlipTool | null {
  if (explicitPath) {
    const flavor = path.basename(explicitPath) === "gm" ? "gm" : "convert";
    return { cmd: explicitPath, flavor };
  }
  if (probe("gm")) return { cmd: "gm", flavor: "gm" };
  if (probe("convert")) return { cmd: "convert", flavor: "convert" };
  return null;
}

/** Convert an SVG file to PNG using rsvg-convert. Rejects if the tool fails. */
export function svgToPng(svgPath: string, pngPath: string): Promise<void> {
  return spawn("rsvg-convert", [svgPath, "-o", pngPath]);
}

/**
 * Flip a PNG vertically and write as TGA — the format WoW expects for addon textures.
 * Use resolveFlipTool() to obtain the tool handle.
 */
export function pngToTga(pngPath: string, tgaPath: string, tool: FlipTool): Promise<void> {
  const args =
    tool.flavor === "gm" ? ["convert", pngPath, "-flip", tgaPath] : [pngPath, "-flip", tgaPath];
  return spawn(tool.cmd, args);
}
