import type {
  DrawLayer,
  FrameIR,
  FramePoint,
  FrameStrata,
  TextureIR,
  FontStringIR,
  RenderObjectIR,
  Anchor,
} from "../parser/ir.js";

export interface AnchorDef {
  point: string;
  relativeTo?: string;
  relativePoint?: string;
  x: number;
  y: number;
}

export interface TextureNode {
  id: number;
  name?: string;
  parentKey?: string;
  layer: string;
  subLevel: number;
  file?: string;
  atlas?: string;
  useAtlasSize?: boolean;
  horizTile?: boolean;
  vertTile?: boolean;
  color?: { r: number; g: number; b: number; a: number };
  texCoords?: { left: number; right: number; top: number; bottom: number };
  alphaMode?: string;
  /** Path to the MaskTexture file that clips this texture (circular portrait mask, etc.). */
  maskFile?: string;
  shown: boolean;
  alpha: number;
  size?: { x?: number; y?: number };
  anchors: AnchorDef[];
  setAllPoints?: boolean;
}

export interface FontStringNode {
  id: number;
  name?: string;
  layer: string;
  subLevel: number;
  text?: string;
  font?: string;
  fontSize?: number;
  justifyH?: string;
  justifyV?: string;
  color?: { r: number; g: number; b: number; a: number };
  shown: boolean;
  alpha: number;
  size?: { x?: number; y?: number };
  anchors: AnchorDef[];
  setAllPoints?: boolean;
}

export interface FrameNode {
  id: number;
  frameType: string;
  name?: string;
  parentId?: number;
  width?: number;
  height?: number;
  anchors: AnchorDef[];
  setAllPoints?: boolean;
  shown: boolean;
  alpha: number;
  scale: number;
  frameLevel?: number;
  frameStrata?: string;
  toplevel?: boolean;
  movable?: boolean;
  resizable?: boolean;
  enableMouse?: boolean;
  numericId?: number;
  childIds: number[];
  textures: TextureNode[];
  fontStrings: FontStringNode[];
  scripts: Map<string, unknown[]>;
  attributes: Map<string, unknown>;
  // Button / EditBox shared text field
  buttonText?: string;
  enabled: boolean;
  // StatusBar
  statusBarMinValue: number;
  statusBarMaxValue: number;
  statusBarValue: number;
  statusBarOrientation: string;
  statusBarColor?: { r: number; g: number; b: number; a: number };
  statusBarTexturePath?: string;
}

export function makeFrameNode(id: number, frameType: string): FrameNode {
  return {
    id,
    frameType,
    anchors: [],
    shown: true,
    alpha: 1,
    scale: 1,
    childIds: [],
    textures: [],
    fontStrings: [],
    scripts: new Map(),
    attributes: new Map(),
    enabled: true,
    statusBarMinValue: 0,
    statusBarMaxValue: 1,
    statusBarValue: 0,
    statusBarOrientation: "HORIZONTAL",
  };
}

export function makeTextureNode(id: number, layer: string, subLevel: number): TextureNode {
  return { id, layer, subLevel, shown: true, alpha: 1, anchors: [] };
}

export function makeFontStringNode(id: number, layer: string): FontStringNode {
  return { id, layer, subLevel: 0, shown: true, alpha: 1, anchors: [] };
}

// ─── IR serialization ─────────────────────────────────────────────────────────

const FRAME_KIND_MAP: Record<string, FrameIR["kind"]> = {
  Frame: "Frame",
  Button: "Button",
  CheckButton: "CheckButton",
  StatusBar: "StatusBar",
  // All other types are serialized as Frame
};

const DRAW_LAYER_ORDER: DrawLayer[] = ["BACKGROUND", "BORDER", "ARTWORK", "OVERLAY", "HIGHLIGHT"];

function anchorDefsToIR(defs: AnchorDef[]): Anchor[] {
  return defs.map((a) => ({
    point: a.point as FramePoint,
    relativeTo: a.relativeTo,
    relativePoint: a.relativePoint as FramePoint | undefined,
    x: a.x,
    y: a.y,
  }));
}

export function textureNodeToIR(tex: TextureNode): TextureIR {
  return {
    kind: "Texture",
    inherits: [],
    mixin: [],
    virtual: false,
    anchors: anchorDefsToIR(tex.anchors),
    setAllPoints: tex.setAllPoints,
    keyValues: [],
    sourceFile: "__runtime__",
    // Unnamed runtime textures get a synthetic name so texture-to-texture SetPoint anchors resolve
    name: tex.name ?? `$tex:${tex.id}`,
    parentKey: tex.parentKey,
    size: tex.size,
    hidden: !tex.shown ? true : undefined,
    alpha: tex.alpha !== 1 ? tex.alpha : undefined,
    file: tex.file,
    atlas: tex.atlas,
    useAtlasSize: tex.useAtlasSize,
    horizTile: tex.horizTile,
    vertTile: tex.vertTile,
    color: tex.color,
    texCoords: tex.texCoords,
    alphaMode: tex.alphaMode as TextureIR["alphaMode"],
    maskFile: tex.maskFile,
  };
}

export function fontStringNodeToIR(fs: FontStringNode): FontStringIR {
  return {
    kind: "FontString",
    inherits: [],
    mixin: [],
    virtual: false,
    anchors: anchorDefsToIR(fs.anchors),
    setAllPoints: fs.setAllPoints,
    keyValues: [],
    sourceFile: "__runtime__",
    name: fs.name,
    size: fs.size,
    hidden: !fs.shown ? true : undefined,
    alpha: fs.alpha !== 1 ? fs.alpha : undefined,
    text: fs.text,
    font: fs.font,
    fontSize: fs.fontSize,
    justifyH: fs.justifyH as FontStringIR["justifyH"],
    justifyV: fs.justifyV as FontStringIR["justifyV"],
    color: fs.color,
  };
}

export function frameNodeToIR(
  node: FrameNode,
  getNode: (id: number) => FrameNode | undefined,
  uiParentId: number,
): FrameIR {
  // Group textures + fontstrings by layer
  const layerMap = new Map<
    string,
    { level: DrawLayer; subLevel: number; objects: RenderObjectIR[] }
  >();

  const getOrMakeLayer = (level: string, sub: number) => {
    const key = `${level}:${sub}`;
    if (!layerMap.has(key)) {
      layerMap.set(key, { level: level as DrawLayer, subLevel: sub, objects: [] });
    }
    return layerMap.get(key)!;
  };

  for (const tex of node.textures) {
    if (!tex.shown) continue;
    getOrMakeLayer(tex.layer, tex.subLevel).objects.push(textureNodeToIR(tex));
  }

  for (const fs of node.fontStrings) {
    if (!fs.shown) continue;
    getOrMakeLayer(fs.layer, 0).objects.push(fontStringNodeToIR(fs));
  }

  const layers = [...layerMap.values()].sort((a, b) => {
    const ai = DRAW_LAYER_ORDER.indexOf(a.level);
    const bi = DRAW_LAYER_ORDER.indexOf(b.level);
    return ai !== bi ? ai - bi : a.subLevel - b.subLevel;
  });

  // Recurse into children
  const children: FrameIR[] = node.childIds
    .map((id) => getNode(id))
    .filter((n): n is FrameNode => n !== undefined)
    .map((child) => frameNodeToIR(child, getNode, uiParentId));

  // Resolve parent name
  const parentNode = node.parentId !== undefined ? getNode(node.parentId) : undefined;
  const parentName = parentNode?.name ?? (node.parentId === uiParentId ? "UIParent" : undefined);

  const interactive =
    (node.scripts.get("OnClick")?.length ?? 0) > 0 ||
    (node.scripts.get("OnEnter")?.length ?? 0) > 0 ||
    (node.scripts.get("OnLeave")?.length ?? 0) > 0;

  return {
    kind: FRAME_KIND_MAP[node.frameType] ?? "Frame",
    name: node.name,
    parent: parentName,
    inherits: [],
    mixin: [],
    virtual: false,
    keyValues: [],
    sourceFile: "__runtime__",
    templateChain: [],
    size:
      node.width !== undefined || node.height !== undefined
        ? { x: node.width, y: node.height }
        : undefined,
    anchors: anchorDefsToIR(node.anchors),
    setAllPoints: node.setAllPoints,
    hidden: !node.shown ? true : undefined,
    alpha: node.alpha !== 1 ? node.alpha : undefined,
    scale: node.scale !== 1 ? node.scale : undefined,
    frameStrata: node.frameStrata as FrameStrata | undefined,
    frameLevel: node.frameLevel,
    toplevel: node.toplevel,
    movable: node.movable,
    resizable: node.resizable,
    enableMouse: node.enableMouse,
    layers,
    children,
    scripts: [],
    buttonText: node.buttonText,
    interactive: interactive || undefined,
    runtimeId: interactive ? node.id : undefined,
    useParentLevel: node.attributes.get("__scryer_useParentLevel") === true ? true : undefined,
  };
}
