export type DrawLayer = "BACKGROUND" | "BORDER" | "ARTWORK" | "OVERLAY" | "HIGHLIGHT";

export type FramePoint =
  | "TOPLEFT"
  | "TOPRIGHT"
  | "BOTTOMLEFT"
  | "BOTTOMRIGHT"
  | "TOP"
  | "BOTTOM"
  | "LEFT"
  | "RIGHT"
  | "CENTER";

export type FrameStrata =
  | "PARENT"
  | "BACKGROUND"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "DIALOG"
  | "FULLSCREEN"
  | "FULLSCREEN_DIALOG"
  | "TOOLTIP"
  | "BLIZZARD";

export type AlphaMode = "DISABLE" | "BLEND" | "ALPHAKEY" | "ADD" | "MOD";

export interface Anchor {
  point: FramePoint;
  relativeTo?: string;
  relativeKey?: string;
  relativePoint?: FramePoint;
  x?: number;
  y?: number;
}

export interface KeyValue {
  key: string;
  value: string;
  type: "nil" | "boolean" | "number" | "string" | "global";
}

export interface ScriptIR {
  event: string;
  inline?: string;
  method?: string;
  function?: string;
  inherit?: "prepend" | "append" | "none";
}

export interface Color {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface LayoutFrameBase {
  kind:
    | "Frame"
    | "Button"
    | "CheckButton"
    | "StatusBar"
    | "Texture"
    | "MaskTexture"
    | "FontString"
    | "Line";
  name?: string;
  parentKey?: string;
  parentArray?: string;
  inherits: string[];
  mixin: string[];
  virtual: boolean;
  size?: { x?: number; y?: number };
  anchors: Anchor[];
  setAllPoints?: boolean;
  hidden?: boolean;
  alpha?: number;
  scale?: number;
  keyValues: KeyValue[];
  sourceFile: string;
  sourceLine?: number;
}

export interface FrameIR extends LayoutFrameBase {
  kind: "Frame" | "Button" | "CheckButton" | "StatusBar";
  parent?: string;
  frameStrata?: FrameStrata;
  frameLevel?: number;
  toplevel?: boolean;
  useParentLevel?: boolean;
  movable?: boolean;
  resizable?: boolean;
  enableMouse?: boolean;
  text?: string;
  layers: { level: DrawLayer; subLevel: number; objects: RenderObjectIR[] }[];
  children: FrameIR[];
  scripts: ScriptIR[];
  templateChain: string[];
  // Button state textures/fonts
  normalTexture?: TextureIR;
  pushedTexture?: TextureIR;
  disabledTexture?: TextureIR;
  highlightTexture?: TextureIR;
  buttonText?: string;
  normalFont?: string;
  highlightFont?: string;
  disabledFont?: string;
  /** Set by live-panel runtime: frame has OnClick/OnEnter/OnLeave handlers. */
  interactive?: boolean;
  /** Set by live-panel runtime: frame has OnDragStart handler (SetMovable+RegisterForDrag). */
  draggable?: boolean;
  /** Live-panel runtime ID used to route webview frameEvent messages back to Lua. */
  runtimeId?: number;
  /** StatusBar fill fraction [0,1] for rendering a proportional fill bar. */
  statusBarFill?: number;
  /** Fill color override for StatusBar (when no texture is set). */
  statusBarFillColor?: { r: number; g: number; b: number; a: number };
  /** Fill texture path for StatusBar. */
  statusBarFillPath?: string;
  /** "HORIZONTAL" or "VERTICAL" fill direction. Default HORIZONTAL. */
  statusBarOrientation?: string;
}

export type RenderObjectIR = TextureIR | FontStringIR;

export interface ResolvedAtlasInfo {
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sheetW: number;
  sheetH: number;
  tilesH: boolean;
  tilesV: boolean;
}

export interface TextureIR extends LayoutFrameBase {
  kind: "Texture" | "MaskTexture";
  file?: string;
  atlas?: string;
  useAtlasSize?: boolean;
  /** Set by SetHorizTile at runtime; overrides the atlas manifest's tiling flag when present. */
  horizTile?: boolean;
  /** Set by SetVertTile at runtime; overrides the atlas manifest's tiling flag when present. */
  vertTile?: boolean;
  /** Populated at render-time from the atlas manifest; absent when manifest is missing or name unknown. */
  resolvedAtlas?: ResolvedAtlasInfo;
  alphaMode?: AlphaMode;
  texCoords?: { left: number; right: number; top: number; bottom: number };
  color?: Color;
  /** Path to the MaskTexture file that clips this texture (circular portrait mask, etc.). */
  maskFile?: string;
  /** parentKeys of textures this MaskTexture clips — consumed during layer parsing, not used at render time. */
  maskedChildKeys?: string[];
}

export interface FontStringIR extends LayoutFrameBase {
  kind: "FontString";
  text?: string;
  /** Named font reference (e.g. "GameFontNormal") or direct file path. */
  font?: string;
  fontSize?: number;
  inheritsFont?: string;
  justifyH?: "LEFT" | "CENTER" | "RIGHT";
  justifyV?: "TOP" | "MIDDLE" | "BOTTOM";
  color?: Color;
}

export interface UiDocument {
  source: string;
  frames: FrameIR[];
  templates: Map<string, FrameIR>;
  textureTemplates: Map<string, TextureIR>;
  scriptFiles: string[];
  includes: string[];
}
