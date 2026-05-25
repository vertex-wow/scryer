import { XMLParser } from "fast-xml-parser";
import type {
  AlphaMode,
  Anchor,
  Color,
  DrawLayer,
  FontStringIR,
  FrameIR,
  FramePoint,
  FrameStrata,
  KeyValue,
  RenderObjectIR,
  ScriptIR,
  TextureIR,
  UiDocument,
} from "./ir.js";

// ---------------------------------------------------------------------------
// Internal tree types for fast-xml-parser preserveOrder output
// ---------------------------------------------------------------------------

type RawNode = { ":@"?: Record<string, string> } & Record<
  string,
  RawNode[] | string | Record<string, string> | undefined
>;

function tagOf(node: RawNode): string {
  return Object.keys(node).find((k) => k !== ":@") ?? "";
}

function attrsOf(node: RawNode): Record<string, string> {
  return (node[":@"] as Record<string, string> | undefined) ?? {};
}

function childrenOf(node: RawNode): RawNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const val = node[tag];
  return Array.isArray(val) ? (val as RawNode[]) : [];
}

function inlineTextOf(children: RawNode[]): string | undefined {
  for (const child of children) {
    if ("#text" in child) return String(child["#text"] ?? "").trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Attribute coercions
// ---------------------------------------------------------------------------

function strAttr(attrs: Record<string, string>, key: string): string | undefined {
  return attrs[key] !== undefined ? String(attrs[key]) : undefined;
}

function numAttr(attrs: Record<string, string>, key: string): number | undefined {
  const v = attrs[key];
  if (v === undefined) return undefined;
  const n = parseFloat(String(v));
  return isNaN(n) ? undefined : n;
}

function boolAttr(attrs: Record<string, string>, key: string): boolean | undefined {
  const v = attrs[key];
  if (v === undefined) return undefined;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return undefined;
}

function splitComma(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Known element categories
// ---------------------------------------------------------------------------

const FRAME_TAGS = new Set([
  "Frame",
  "Button",
  "CheckButton",
  "StatusBar",
  "UnitPositionFrame",
  "Slider",
  "ScrollFrame",
  "EditBox",
  "SimpleHTML",
  "GameTooltip",
  "ColorSelect",
  "Cooldown",
  "Model",
  "PlayerModel",
  "TabardModel",
  "DressUpModel",
  "ModelScene",
  "FogOfWarFrame",
  "MovieFrame",
  "ArchaeologyDigSiteFrame",
  "ScrollingMessageFrame",
  "Browser",
  "Minimap",
  "WorldFrame",
  "ItemButton",
]);

const RENDER_TAGS = new Set(["Texture", "MaskTexture", "FontString"]);

const BUTTON_TEXTURE_TAGS: Record<
  string,
  keyof Pick<FrameIR, "normalTexture" | "pushedTexture" | "disabledTexture" | "highlightTexture">
> = {
  NormalTexture: "normalTexture",
  PushedTexture: "pushedTexture",
  DisabledTexture: "disabledTexture",
  HighlightTexture: "highlightTexture",
};

const BUTTON_FONT_TAGS: Record<
  string,
  keyof Pick<FrameIR, "normalFont" | "highlightFont" | "disabledFont">
> = {
  NormalFont: "normalFont",
  HighlightFont: "highlightFont",
  DisabledFont: "disabledFont",
};

// ---------------------------------------------------------------------------
// Sub-element parsers
// ---------------------------------------------------------------------------

function parseColor(node: RawNode): Color {
  const a = attrsOf(node);
  return {
    r: numAttr(a, "r") ?? 1,
    g: numAttr(a, "g") ?? 1,
    b: numAttr(a, "b") ?? 1,
    ...(a["a"] !== undefined ? { a: numAttr(a, "a") } : {}),
  };
}

function parseAnchor(node: RawNode): Anchor {
  const a = attrsOf(node);
  const anchor: Anchor = {
    point: (strAttr(a, "point") ?? "CENTER") as FramePoint,
  };
  const relativeTo = strAttr(a, "relativeTo");
  if (relativeTo) anchor.relativeTo = relativeTo;
  const relativeKey = strAttr(a, "relativeKey");
  if (relativeKey) anchor.relativeKey = relativeKey;
  const relativePoint = strAttr(a, "relativePoint");
  if (relativePoint) anchor.relativePoint = relativePoint as FramePoint;
  const x = numAttr(a, "x");
  if (x !== undefined) anchor.x = x;
  const y = numAttr(a, "y");
  if (y !== undefined) anchor.y = y;
  // Offset sub-element (alternative to x/y attrs)
  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === "Offset") {
      const ca = attrsOf(child);
      const ox = numAttr(ca, "x");
      const oy = numAttr(ca, "y");
      if (ox !== undefined) anchor.x = ox;
      if (oy !== undefined) anchor.y = oy;
      // AbsDimension child of Offset
      for (const sub of childrenOf(child)) {
        if (tagOf(sub) === "AbsDimension") {
          const sa = attrsOf(sub);
          const ax = numAttr(sa, "x");
          const ay = numAttr(sa, "y");
          if (ax !== undefined) anchor.x = ax;
          if (ay !== undefined) anchor.y = ay;
        }
      }
    }
  }
  return anchor;
}

function parseAnchors(node: RawNode): Anchor[] {
  return childrenOf(node)
    .filter((c) => tagOf(c) === "Anchor")
    .map(parseAnchor);
}

function parseSize(node: RawNode): { x?: number; y?: number } {
  const a = attrsOf(node);
  const size: { x?: number; y?: number } = {};
  const x = numAttr(a, "x");
  if (x !== undefined) size.x = x;
  const y = numAttr(a, "y");
  if (y !== undefined) size.y = y;
  // AbsDimension child
  for (const child of childrenOf(node)) {
    if (tagOf(child) === "AbsDimension") {
      const ca = attrsOf(child);
      const cx = numAttr(ca, "x");
      const cy = numAttr(ca, "y");
      if (cx !== undefined) size.x = cx;
      if (cy !== undefined) size.y = cy;
    }
  }
  return size;
}

function parseKeyValues(node: RawNode): KeyValue[] {
  return childrenOf(node)
    .filter((c) => tagOf(c) === "KeyValue")
    .map((c) => {
      const a = attrsOf(c);
      return {
        key: strAttr(a, "key") ?? "",
        value: strAttr(a, "value") ?? "",
        type: (strAttr(a, "type") ?? "string") as KeyValue["type"],
      };
    });
}

function parseScriptNode(node: RawNode): ScriptIR {
  const event = tagOf(node);
  const a = attrsOf(node);
  const script: ScriptIR = { event };
  const method = strAttr(a, "method");
  if (method) script.method = method;
  const fn = strAttr(a, "function");
  if (fn) script.function = fn;
  const inherit = strAttr(a, "inherit");
  if (inherit) script.inherit = inherit as ScriptIR["inherit"];
  const inlineText = inlineTextOf(childrenOf(node));
  if (inlineText) script.inline = inlineText;
  return script;
}

const KNOWN_SCRIPT_EVENTS = new Set([
  "OnLoad",
  "OnShow",
  "OnHide",
  "OnUpdate",
  "OnEvent",
  "OnClick",
  "OnDoubleClick",
  "OnMouseDown",
  "OnMouseUp",
  "OnMouseWheel",
  "OnEnter",
  "OnLeave",
  "OnDragStart",
  "OnDragStop",
  "OnReceiveDrag",
  "OnValueChanged",
  "OnTextChanged",
  "OnTextSet",
  "OnEditFocusGained",
  "OnEditFocusLost",
  "OnEscapePressed",
  "OnTabPressed",
  "OnEnterPressed",
  "OnSpacePressed",
  "OnChar",
  "OnKeyDown",
  "OnKeyUp",
  "OnAttributeChanged",
  "OnSizeChanged",
  "OnScrollRangeChanged",
  "OnHorizontalScroll",
  "OnVerticalScroll",
  "OnMinMaxChanged",
  "OnStopMoving",
  "OnStopResizing",
  "PostClick",
  "PreClick",
]);

function parseScripts(node: RawNode): ScriptIR[] {
  return childrenOf(node)
    .filter((c) => {
      const t = tagOf(c);
      return KNOWN_SCRIPT_EVENTS.has(t) || t.startsWith("On");
    })
    .map(parseScriptNode);
}

function parseTexture(node: RawNode, sourceFile: string): TextureIR {
  const tag = tagOf(node);
  const a = attrsOf(node);
  const children = childrenOf(node);

  const tex: TextureIR = {
    kind: tag === "MaskTexture" ? "MaskTexture" : "Texture",
    inherits: [],
    mixin: [],
    virtual: boolAttr(a, "virtual") ?? false,
    anchors: [],
    keyValues: [],
    sourceFile,
  };

  const name = strAttr(a, "name");
  if (name) tex.name = name;
  const parentKey = strAttr(a, "parentKey");
  if (parentKey) tex.parentKey = parentKey;
  const parentArray = strAttr(a, "parentArray");
  if (parentArray) tex.parentArray = parentArray;
  const file = strAttr(a, "file");
  if (file) tex.file = normPath(file);
  const atlas = strAttr(a, "atlas");
  if (atlas) tex.atlas = atlas;
  const useAtlasSize = boolAttr(a, "useAtlasSize");
  if (useAtlasSize !== undefined) tex.useAtlasSize = useAtlasSize;
  const alphaMode = strAttr(a, "alphaMode");
  if (alphaMode) tex.alphaMode = alphaMode as AlphaMode;
  const setAllPoints = boolAttr(a, "setAllPoints");
  if (setAllPoints !== undefined) tex.setAllPoints = setAllPoints;
  const hidden = boolAttr(a, "hidden");
  if (hidden !== undefined) tex.hidden = hidden;
  const alpha = numAttr(a, "alpha");
  if (alpha !== undefined) tex.alpha = alpha;

  for (const child of children) {
    switch (tagOf(child)) {
      case "Size":
        tex.size = parseSize(child);
        break;
      case "Anchors":
        tex.anchors = parseAnchors(child);
        break;
      case "Color":
        tex.color = parseColor(child);
        break;
      case "TexCoords": {
        const ca = attrsOf(child);
        tex.texCoords = {
          left: numAttr(ca, "left") ?? 0,
          right: numAttr(ca, "right") ?? 1,
          top: numAttr(ca, "top") ?? 0,
          bottom: numAttr(ca, "bottom") ?? 1,
        };
        break;
      }
    }
  }

  return tex;
}

function parseFontString(node: RawNode, sourceFile: string): FontStringIR {
  const a = attrsOf(node);
  const children = childrenOf(node);

  const fs: FontStringIR = {
    kind: "FontString",
    inherits: [],
    mixin: [],
    virtual: boolAttr(a, "virtual") ?? false,
    anchors: [],
    keyValues: [],
    sourceFile,
  };

  const name = strAttr(a, "name");
  if (name) fs.name = name;
  const parentKey = strAttr(a, "parentKey");
  if (parentKey) fs.parentKey = parentKey;
  const parentArray = strAttr(a, "parentArray");
  if (parentArray) fs.parentArray = parentArray;
  const inheritsFont = strAttr(a, "inherits");
  if (inheritsFont) fs.inheritsFont = inheritsFont;
  const text = strAttr(a, "text");
  if (text !== undefined) fs.text = text;
  const justifyH = strAttr(a, "justifyH");
  if (justifyH) fs.justifyH = justifyH as FontStringIR["justifyH"];
  const justifyV = strAttr(a, "justifyV");
  if (justifyV) fs.justifyV = justifyV as FontStringIR["justifyV"];
  const setAllPoints = boolAttr(a, "setAllPoints");
  if (setAllPoints !== undefined) fs.setAllPoints = setAllPoints;
  const hidden = boolAttr(a, "hidden");
  if (hidden !== undefined) fs.hidden = hidden;
  const alpha = numAttr(a, "alpha");
  if (alpha !== undefined) fs.alpha = alpha;

  for (const child of children) {
    switch (tagOf(child)) {
      case "Size":
        fs.size = parseSize(child);
        break;
      case "Anchors":
        fs.anchors = parseAnchors(child);
        break;
      case "Color":
        fs.color = parseColor(child);
        break;
    }
  }

  return fs;
}

function parseLayer(
  node: RawNode,
  sourceFile: string,
): { level: DrawLayer; subLevel: number; objects: RenderObjectIR[] } {
  const a = attrsOf(node);
  const level = (strAttr(a, "level") ?? "ARTWORK") as DrawLayer;
  const subLevel = numAttr(a, "subLevel") ?? 0;
  const objects: RenderObjectIR[] = [];

  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === "Texture" || tag === "MaskTexture") {
      objects.push(parseTexture(child, sourceFile));
    } else if (tag === "FontString") {
      objects.push(parseFontString(child, sourceFile));
    }
    // Line and other render objects: silently skip for now
  }

  return { level, subLevel, objects };
}

// Forward declaration — parseFrame references itself for children
function parseFrame(node: RawNode, sourceFile: string): FrameIR {
  const tag = tagOf(node);
  const a = attrsOf(node);
  const children = childrenOf(node);

  const frameKind = (
    FRAME_TAGS.has(tag) &&
    (tag === "Frame" || tag === "Button" || tag === "CheckButton" || tag === "StatusBar")
      ? tag
      : "Frame"
  ) as FrameIR["kind"];

  const frame: FrameIR = {
    kind: frameKind,
    inherits: splitComma(strAttr(a, "inherits")),
    mixin: splitComma(strAttr(a, "mixin")),
    virtual: boolAttr(a, "virtual") ?? false,
    anchors: [],
    keyValues: [],
    sourceFile,
    layers: [],
    children: [],
    scripts: [],
    templateChain: [],
  };

  const name = strAttr(a, "name");
  if (name) frame.name = name;
  const parentKey = strAttr(a, "parentKey");
  if (parentKey) frame.parentKey = parentKey;
  const parentArray = strAttr(a, "parentArray");
  if (parentArray) frame.parentArray = parentArray;
  const parent = strAttr(a, "parent");
  if (parent) frame.parent = parent;
  const hidden = boolAttr(a, "hidden");
  if (hidden !== undefined) frame.hidden = hidden;
  const alpha = numAttr(a, "alpha");
  if (alpha !== undefined) frame.alpha = alpha;
  const scale = numAttr(a, "scale");
  if (scale !== undefined) frame.scale = scale;
  const frameStrata = strAttr(a, "frameStrata");
  if (frameStrata) frame.frameStrata = frameStrata as FrameStrata;
  const frameLevel = numAttr(a, "frameLevel");
  if (frameLevel !== undefined) frame.frameLevel = frameLevel;
  const toplevel = boolAttr(a, "toplevel");
  if (toplevel !== undefined) frame.toplevel = toplevel;
  const movable = boolAttr(a, "movable");
  if (movable !== undefined) frame.movable = movable;
  const resizable = boolAttr(a, "resizable");
  if (resizable !== undefined) frame.resizable = resizable;
  const enableMouse = boolAttr(a, "enableMouse");
  if (enableMouse !== undefined) frame.enableMouse = enableMouse;
  const text = strAttr(a, "text");
  if (text !== undefined) frame.text = text;
  const setAllPoints = boolAttr(a, "setAllPoints");
  if (setAllPoints !== undefined) frame.setAllPoints = setAllPoints;

  for (const child of children) {
    const childTag = tagOf(child);

    switch (childTag) {
      case "Size":
        frame.size = parseSize(child);
        break;
      case "Anchors":
        frame.anchors = parseAnchors(child);
        break;
      case "KeyValues":
        frame.keyValues = parseKeyValues(child);
        break;
      case "Scripts":
        frame.scripts = parseScripts(child);
        break;
      case "Layers":
        for (const layerNode of childrenOf(child)) {
          if (tagOf(layerNode) === "Layer") {
            frame.layers.push(parseLayer(layerNode, sourceFile));
          }
        }
        break;
      case "Frames":
        for (const childFrameNode of childrenOf(child)) {
          const ct = tagOf(childFrameNode);
          if (FRAME_TAGS.has(ct)) {
            frame.children.push(parseFrame(childFrameNode, sourceFile));
          }
        }
        break;
      case "NormalTexture":
      case "PushedTexture":
      case "DisabledTexture":
      case "HighlightTexture": {
        const fieldKey = BUTTON_TEXTURE_TAGS[childTag];
        // Parse as Texture but the node tag is NormalTexture etc.
        // We need to fake the tag as "Texture" for parseTexture.
        const fakeNode: RawNode = { Texture: childrenOf(child), ":@": attrsOf(child) };
        frame[fieldKey] = parseTexture(fakeNode, sourceFile);
        break;
      }
      case "NormalFont":
      case "HighlightFont":
      case "DisabledFont": {
        const fieldKey = BUTTON_FONT_TAGS[childTag];
        const ca = attrsOf(child);
        frame[fieldKey] = strAttr(ca, "style");
        break;
      }
      case "ButtonText": {
        const ca = attrsOf(child);
        frame.buttonText = strAttr(ca, "text");
        break;
      }
      case "HitRectInsets":
      case "ResizeBounds":
      case "Attributes":
        // Not needed for M1 rendering; silently skip
        break;
    }
  }

  return frame;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const XML_PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  commentPropName: "#comment",
});

export function parseXmlFile(source: string, content: string): UiDocument {
  const nodes = XML_PARSER.parse(content) as RawNode[];

  const uiNode = nodes.find((n) => tagOf(n) === "Ui");
  if (!uiNode) {
    throw new Error(`No <Ui> root element in ${source}`);
  }

  const doc: UiDocument = {
    source,
    frames: [],
    templates: new Map(),
    scriptFiles: [],
    includes: [],
  };

  for (const child of childrenOf(uiNode)) {
    const tag = tagOf(child);
    const a = attrsOf(child);

    if (tag === "Script") {
      const file = strAttr(a, "file");
      if (file) {
        doc.scriptFiles.push(normPath(file));
      }
      // Inline script bodies are not registered here — they belong to
      // specific frame scripts; a bare top-level <Script> with body is
      // unusual but we just ignore the body for now.
    } else if (tag === "Include") {
      const file = strAttr(a, "file");
      if (file) doc.includes.push(normPath(file));
    } else if (FRAME_TAGS.has(tag)) {
      const frame = parseFrame(child, source);
      if (frame.virtual) {
        if (frame.name) {
          doc.templates.set(frame.name, frame);
        }
      } else {
        doc.frames.push(frame);
      }
    }
  }

  return doc;
}
