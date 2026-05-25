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
}

export type RenderObjectIR = TextureIR | FontStringIR;

export interface TextureIR extends LayoutFrameBase {
  kind: "Texture" | "MaskTexture";
  file?: string;
  atlas?: string;
  useAtlasSize?: boolean;
  alphaMode?: AlphaMode;
  texCoords?: { left: number; right: number; top: number; bottom: number };
  color?: Color;
}

export interface FontStringIR extends LayoutFrameBase {
  kind: "FontString";
  text?: string;
  inheritsFont?: string;
  justifyH?: "LEFT" | "CENTER" | "RIGHT";
  justifyV?: "TOP" | "MIDDLE" | "BOTTOM";
  color?: Color;
}

export interface UiDocument {
  source: string;
  frames: FrameIR[];
  templates: Map<string, FrameIR>;
  scriptFiles: string[];
  includes: string[];
}
