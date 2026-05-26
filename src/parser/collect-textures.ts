import type { FrameIR, TextureIR } from "./ir.js";

function collectFromTexture(tex: TextureIR | undefined, out: Set<string>): void {
  if (tex?.file) out.add(tex.file);
}

function collectFromFrame(frame: FrameIR, out: Set<string>): void {
  for (const layer of frame.layers) {
    for (const obj of layer.objects) {
      if (obj.kind === "Texture" || obj.kind === "MaskTexture") {
        collectFromTexture(obj as TextureIR, out);
      }
    }
  }
  collectFromTexture(frame.normalTexture, out);
  collectFromTexture(frame.pushedTexture, out);
  collectFromTexture(frame.disabledTexture, out);
  collectFromTexture(frame.highlightTexture, out);
  for (const child of frame.children) {
    collectFromFrame(child, out);
  }
}

/**
 * Walk a resolved frame tree and return every distinct texture file path
 * referenced across all layers, button textures, and children.
 */
export function collectTexturePaths(frames: FrameIR[]): string[] {
  const out = new Set<string>();
  for (const frame of frames) {
    collectFromFrame(frame, out);
  }
  return Array.from(out);
}
