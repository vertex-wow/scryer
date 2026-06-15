import { type LuaEngine } from "wasmoon";
import frameClassLua from "./frame-class.lua";
import { FrameRegistry } from "./frame-registry.js";
import type { TextureNode, FontStringNode, AnchorDef } from "./frame-model.js";
import { resolveInheritance } from "../parser/inherit.js";
import type { FrameIR, ScriptIR, TextureIR, FontStringIR, UiDocument } from "../parser/ir.js";
import type { AtlasManifest } from "../assets/atlas-manifest.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function toNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function toStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Convert a Lua-side relTo argument (number ID or string name) to an anchor relativeTo string. */
function resolveRelTo(v: unknown, registry: FrameRegistry): string | undefined {
  if (typeof v === "number") return registry.resolveRelTo(v);
  if (typeof v === "string") return v;
  return undefined;
}

function pushAnchor(
  anchors: AnchorDef[],
  point: unknown,
  relTo: unknown,
  relPoint: unknown,
  x: unknown,
  y: unknown,
  registry: FrameRegistry,
): void {
  if (typeof point !== "string") return;
  anchors.push({
    point,
    relativeTo: resolveRelTo(relTo, registry),
    relativePoint: toStr(relPoint),
    x: toNum(x) ?? 0,
    y: toNum(y) ?? 0,
  });
}

function sizeNode(node: { size?: { x?: number; y?: number } }, w: unknown, h: unknown): void {
  const wn = toNum(w);
  const hn = toNum(h);
  if (wn !== undefined || hn !== undefined) {
    node.size = node.size ?? {};
    if (wn !== undefined) node.size.x = wn;
    if (hn !== undefined) node.size.y = hn;
  }
}

// ─── Template code generation ─────────────────────────────────────────────────

function emitTplAnchor(
  selfVar: string,
  ir: { anchors: FrameIR["anchors"]; setAllPoints?: boolean },
  lines: string[],
): void {
  if (ir.setAllPoints) {
    const relTo = ir.anchors[0]?.relativeTo ?? ir.anchors[0]?.relativeKey;
    lines.push(`${selfVar}:SetAllPoints(${relTo ? JSON.stringify(relTo) : "nil"})`);
    return;
  }
  for (const a of ir.anchors) {
    const relTo = a.relativeTo ?? a.relativeKey;
    const relToExpr = relTo ? JSON.stringify(relTo) : "nil";
    const relPoint = a.relativePoint ? JSON.stringify(a.relativePoint) : "nil";
    lines.push(
      `${selfVar}:SetPoint(${JSON.stringify(a.point)}, ${relToExpr}, ${relPoint}, ${a.x ?? 0}, ${a.y ?? 0})`,
    );
  }
}

function emitTplScript(
  selfVar: string,
  script: ScriptIR,
  lines: string[],
  lua: LuaEngine,
  xsIdx: { n: number },
): void {
  if (script.inline) {
    const i = xsIdx.n++;
    const gname = `__scryer_xs${i}`;
    lua.global.set(
      gname,
      `return function(self, event, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) ${script.inline} end`,
    );
    lines.push(`do`);
    lines.push(`  local _src = ${gname}`);
    lines.push(`  ${gname} = nil`);
    lines.push(`  local _fn, _err = load(_src)`);
    lines.push(
      `  if _fn then ${selfVar}:SetScript(${JSON.stringify(script.event)}, _fn())` +
        ` elseif _err then print("[Scryer] template script error: " .. tostring(_err)) end`,
    );
    lines.push(`end`);
  } else if (script.function) {
    lines.push(`${selfVar}:SetScript(${JSON.stringify(script.event)}, ${script.function})`);
  }
}

/**
 * Generate Lua code that applies a resolved template's layers (textures/fontstrings),
 * size, anchors, and scripts to an existing frame referenced by `selfVar`.
 * Inline script bodies are injected as Lua globals via `lua.global.set` before the
 * caller executes the returned string.
 */
function generateTemplateBody(
  tpl: FrameIR,
  selfVar: string,
  lua: LuaEngine,
  xsIdx: { n: number },
): string {
  const lines: string[] = [];
  let objIdx = 0;

  if (tpl.size?.x !== undefined || tpl.size?.y !== undefined) {
    lines.push(`${selfVar}:SetSize(${tpl.size?.x ?? 0}, ${tpl.size?.y ?? 0})`);
  }

  emitTplAnchor(selfVar, tpl, lines);

  for (const layer of tpl.layers) {
    for (const obj of layer.objects) {
      const v = `_tpl${objIdx++}`;
      if (obj.kind === "Texture" || obj.kind === "MaskTexture") {
        const tex = obj as TextureIR;
        const qname = tex.name ? JSON.stringify(tex.name) : "nil";
        lines.push(
          `local ${v} = ${selfVar}:CreateTexture(${qname}, ${JSON.stringify(layer.level)}, nil, ${layer.subLevel})`,
        );
        lines.push(`if ${v} then`);
        if (tex.file) lines.push(`  ${v}:SetTexture(${JSON.stringify(tex.file)})`);
        if (tex.atlas)
          lines.push(
            `  ${v}:SetAtlas(${JSON.stringify(tex.atlas)}, ${tex.useAtlasSize ? "true" : "false"})`,
          );
        if (tex.color) {
          const { r, g, b, a = 1 } = tex.color;
          lines.push(`  ${v}:SetColorTexture(${r}, ${g}, ${b}, ${a})`);
        }
        if (tex.texCoords) {
          const { left, right, top, bottom } = tex.texCoords;
          lines.push(`  ${v}:SetTexCoord(${left}, ${right}, ${top}, ${bottom})`);
        }
        if (tex.hidden) lines.push(`  ${v}:Hide()`);
        if (tex.alpha !== undefined) lines.push(`  ${v}:SetAlpha(${tex.alpha})`);
        if (tex.size?.x !== undefined || tex.size?.y !== undefined)
          lines.push(`  ${v}:SetSize(${tex.size?.x ?? 0}, ${tex.size?.y ?? 0})`);
        const texAnchorLines: string[] = [];
        emitTplAnchor(`  ${v}`, tex, texAnchorLines);
        for (const l of texAnchorLines) lines.push(l);
        if (tex.maskFile) lines.push(`  ${v}:__SetMaskFile(${JSON.stringify(tex.maskFile)})`);
        if (tex.parentKey) {
          lines.push(`  ${selfVar}.${tex.parentKey} = ${v}`);
          lines.push(`  ${v}:__SetParentKey(${JSON.stringify(tex.parentKey)})`);
        }
        if (tex.parentArray) {
          lines.push(`  ${selfVar}.${tex.parentArray} = ${selfVar}.${tex.parentArray} or {}`);
          lines.push(`  table.insert(${selfVar}.${tex.parentArray}, ${v})`);
        }
        lines.push(`end`);
      } else if (obj.kind === "FontString") {
        const fs = obj as FontStringIR;
        const qname = fs.name ? JSON.stringify(fs.name) : "nil";
        lines.push(
          `local ${v} = ${selfVar}:CreateFontString(${qname}, ${JSON.stringify(layer.level)})`,
        );
        lines.push(`if ${v} then`);
        if (fs.text) lines.push(`  ${v}:SetText(${JSON.stringify(fs.text)})`);
        if (fs.color) {
          const { r, g, b, a = 1 } = fs.color;
          lines.push(`  ${v}:SetTextColor(${r}, ${g}, ${b}, ${a})`);
        }
        if (fs.font && fs.fontSize !== undefined)
          lines.push(`  ${v}:SetFont(${JSON.stringify(fs.font)}, ${fs.fontSize})`);
        if (fs.justifyH) lines.push(`  ${v}:SetJustifyH(${JSON.stringify(fs.justifyH)})`);
        if (fs.justifyV) lines.push(`  ${v}:SetJustifyV(${JSON.stringify(fs.justifyV)})`);
        if (fs.hidden) lines.push(`  ${v}:Hide()`);
        if (fs.alpha !== undefined) lines.push(`  ${v}:SetAlpha(${fs.alpha})`);
        if (fs.size?.x !== undefined || fs.size?.y !== undefined)
          lines.push(`  ${v}:SetSize(${fs.size?.x ?? 0}, ${fs.size?.y ?? 0})`);
        const fsAnchorLines: string[] = [];
        emitTplAnchor(`  ${v}`, fs, fsAnchorLines);
        for (const l of fsAnchorLines) lines.push(l);
        if (fs.parentKey) lines.push(`  ${selfVar}.${fs.parentKey} = ${v}`);
        if (fs.parentArray) {
          lines.push(`  ${selfVar}.${fs.parentArray} = ${selfVar}.${fs.parentArray} or {}`);
          lines.push(`  table.insert(${selfVar}.${fs.parentArray}, ${v})`);
        }
        lines.push(`end`);
      }
    }
  }

  const onLoadScripts: ScriptIR[] = [];
  for (const script of tpl.scripts) {
    if (script.event === "OnLoad") {
      onLoadScripts.push(script);
    } else {
      emitTplScript(selfVar, script, lines, lua, xsIdx);
    }
  }
  for (const script of onLoadScripts) {
    emitTplScript(selfVar, script, lines, lua, xsIdx);
  }
  if (onLoadScripts.length > 0) {
    lines.push(
      `if type(__scryer_dispatch_script) == "function" then __scryer_dispatch_script(${selfVar}.__id, "OnLoad") end`,
    );
  }

  return lines.join("\n");
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Inject the WoW frame object model into an existing M5+M6 sandbox.
 * Creates UIParent/WorldFrame, registers CreateFrame and all widget methods,
 * and bootstraps the Lua class metatables.
 *
 * Must be called after registerWowApi().
 */
function lookupAtlasSize(
  name: string,
  manifest: AtlasManifest,
): { w: number; h: number } | undefined {
  const origLower = name.toLowerCase();
  const stripped = name.replace(/^[_!]+/, "");
  const strippedLower = stripped.toLowerCase();
  let entry =
    manifest[name] ?? manifest[origLower] ?? manifest[stripped] ?? manifest[strippedLower];
  let d = 1;
  if (!entry) {
    entry = manifest[origLower + "-2x"] ?? manifest[strippedLower + "-2x"];
    if (entry) d = entry.logicalW > 0 ? entry.width / entry.logicalW : 2;
  }
  if (!entry) return undefined;
  return { w: entry.width / d, h: entry.height / d };
}

export async function registerFrameModel(
  lua: LuaEngine,
  registry: FrameRegistry,
  blizzardTemplates?: Map<string, FrameIR>,
  blizzardTextureTemplates?: Map<string, TextureIR>,
  atlasManifest?: AtlasManifest,
): Promise<void> {
  // ── UIParent / WorldFrame IDs ──────────────────────────────────────────────
  // Expose as globals so frame-class.lua can capture them as upvalues.
  lua.global.set("__scryer_ui_parent_id", registry.uiParentId);
  lua.global.set("__scryer_world_frame_id", registry.worldFrameId);

  // ── Template application ───────────────────────────────────────────────────
  // Cache of resolved templates (key = comma-joined template names).
  const templateCache = new Map<string, FrameIR | null>();

  function resolveTemplateNames(names: string[]): FrameIR | null {
    if (!blizzardTemplates) return null;
    const key = names.join(",");
    if (templateCache.has(key)) return templateCache.get(key)!;
    const hasAny = names.some((n) => blizzardTemplates.has(n));
    if (!hasAny) {
      templateCache.set(key, null);
      return null;
    }
    const synthFrame: FrameIR = {
      kind: "Frame",
      inherits: names,
      mixin: [],
      virtual: true,
      sourceFile: "__apply_template__",
      anchors: [],
      keyValues: [],
      layers: [],
      children: [],
      scripts: [],
      templateChain: [],
    };
    const synthDoc: UiDocument = {
      source: "__apply_template__",
      frames: [synthFrame],
      templates: new Map(),
      textureTemplates: new Map(),
      scriptFiles: [],
      includes: [],
    };
    const [resolved] = resolveInheritance(
      [synthDoc],
      blizzardTemplates,
      {},
      blizzardTextureTemplates,
    );
    const result = resolved.frames[0] ?? null;
    templateCache.set(key, result);
    return result;
  }

  const xsIdx = { n: 0 };

  lua.global.set("__scryer_apply_template", (_fid: unknown, templateStr: unknown): string => {
    if (typeof templateStr !== "string" || !templateStr.trim()) return "";
    const names = templateStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return "";
    const resolved = resolveTemplateNames(names);
    if (!resolved) return "";
    xsIdx.n = 0;
    return generateTemplateBody(resolved, "__scryer_tpl_frame", lua, xsIdx);
  });

  // ── Frame helpers ──────────────────────────────────────────────────────────

  lua.global.set(
    "__scryer_frame_new",
    (
      frameType: unknown,
      name: unknown,
      parentId: unknown,
      _template: unknown,
    ): number | undefined => {
      const node = registry.createFrame(
        typeof frameType === "string" ? frameType : "Frame",
        typeof name === "string" && name.length > 0 ? name : null,
        typeof parentId === "number" ? parentId : null,
      );
      return node.id;
    },
  );

  lua.global.set("__scryer_frame_get_name", (id: unknown): string | undefined => {
    return registry.getFrame(toNum(id)!)?.name;
  });

  lua.global.set("__scryer_frame_set_id", (id: unknown, numId: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.numericId = toNum(numId);
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_get_id", (id: unknown): number | undefined => {
    return registry.getFrame(toNum(id)!)?.numericId;
  });

  lua.global.set("__scryer_frame_get_parent", (id: unknown): number | undefined => {
    return registry.getFrame(toNum(id)!)?.parentId;
  });

  lua.global.set("__scryer_frame_set_parent", (id: unknown, newParentId: unknown): void => {
    registry.reparent(toNum(id)!, typeof newParentId === "number" ? newParentId : null);
  });

  lua.global.set("__scryer_frame_set_size", (id: unknown, w: unknown, h: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    if (toNum(w) !== undefined) node.width = toNum(w);
    if (toNum(h) !== undefined) node.height = toNum(h);
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_get_width", (id: unknown): number | undefined => {
    return registry.getFrame(toNum(id)!)?.width;
  });

  lua.global.set("__scryer_frame_get_height", (id: unknown): number | undefined => {
    return registry.getFrame(toNum(id)!)?.height;
  });

  lua.global.set(
    "__scryer_frame_set_point",
    (
      id: unknown,
      point: unknown,
      relTo: unknown,
      relPoint: unknown,
      x: unknown,
      y: unknown,
    ): void => {
      const node = registry.getFrame(toNum(id)!);
      if (!node) return;
      pushAnchor(node.anchors, point, relTo, relPoint, x, y, registry);
      registry.markDirty();
    },
  );

  lua.global.set("__scryer_frame_clear_points", (id: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.anchors = [];
    node.setAllPoints = undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_set_all_points", (id: unknown, relTo: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    const relativeTo = resolveRelTo(relTo, registry);
    node.anchors = [];
    node.setAllPoints = true;
    if (relativeTo) {
      node.anchors.push({ point: "TOPLEFT", relativeTo, relativePoint: "TOPLEFT", x: 0, y: 0 });
      node.anchors.push({
        point: "BOTTOMRIGHT",
        relativeTo,
        relativePoint: "BOTTOMRIGHT",
        x: 0,
        y: 0,
      });
    }
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_show", (id: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.shown = true;
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_hide", (id: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.shown = false;
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_is_shown", (id: unknown): boolean => {
    return registry.getFrame(toNum(id)!)?.shown ?? false;
  });

  lua.global.set("__scryer_frame_set_alpha", (id: unknown, a: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.alpha = clamp01(toNum(a) ?? 1);
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_get_alpha", (id: unknown): number => {
    return registry.getFrame(toNum(id)!)?.alpha ?? 1;
  });

  lua.global.set("__scryer_frame_set_scale", (id: unknown, s: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.scale = toNum(s) ?? 1;
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_get_scale", (id: unknown): number => {
    return registry.getFrame(toNum(id)!)?.scale ?? 1;
  });

  lua.global.set("__scryer_frame_set_strata", (id: unknown, s: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.frameStrata = toStr(s);
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_get_strata", (id: unknown): string | undefined => {
    return registry.getFrame(toNum(id)!)?.frameStrata;
  });

  lua.global.set("__scryer_frame_set_level", (id: unknown, l: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.frameLevel = toNum(l);
    registry.markDirty();
  });

  lua.global.set("__scryer_frame_get_level", (id: unknown): number | undefined => {
    return registry.getFrame(toNum(id)!)?.frameLevel;
  });

  lua.global.set("__scryer_frame_get_type", (id: unknown): string => {
    return registry.getFrame(toNum(id)!)?.frameType ?? "Frame";
  });

  // Scripts are stored as arrays of handlers (hook support).
  lua.global.set("__scryer_frame_set_script", (id: unknown, event: unknown, fn: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node || typeof event !== "string") return;
    node.scripts.set(event, fn !== null && fn !== undefined ? [fn] : []);
  });

  lua.global.set("__scryer_frame_get_script", (id: unknown, event: unknown): unknown => {
    const node = registry.getFrame(toNum(id)!);
    if (!node || typeof event !== "string") return undefined;
    const handlers = node.scripts.get(event);
    return handlers && handlers.length > 0 ? handlers[0] : undefined;
  });

  lua.global.set("__scryer_frame_hook_script", (id: unknown, event: unknown, fn: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node || typeof event !== "string" || fn == null) return;
    const handlers = node.scripts.get(event) ?? [];
    handlers.push(fn);
    node.scripts.set(event, handlers);
  });

  // Events stored as attributes; not dispatched until M9.
  lua.global.set("__scryer_frame_register_event", (id: unknown, event: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node || typeof event !== "string") return;
    node.attributes.set(`__event_${event}`, true);
  });

  lua.global.set("__scryer_frame_unregister_event", (id: unknown, event: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node || typeof event !== "string") return;
    node.attributes.delete(`__event_${event}`);
  });

  lua.global.set("__scryer_frame_unregister_all_events", (id: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    for (const key of [...node.attributes.keys()]) {
      if (key.startsWith("__event_")) node.attributes.delete(key);
    }
  });

  lua.global.set("__scryer_frame_set_attribute", (id: unknown, k: unknown, v: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node || typeof k !== "string") return;
    node.attributes.set(k, v ?? undefined);
  });

  lua.global.set("__scryer_frame_get_attribute", (id: unknown, k: unknown): unknown => {
    const node = registry.getFrame(toNum(id)!);
    if (!node || typeof k !== "string") return undefined;
    return node.attributes.get(k) ?? undefined;
  });

  lua.global.set("__scryer_frame_get_children_count", (id: unknown): number => {
    return registry.getFrame(toNum(id)!)?.childIds.length ?? 0;
  });

  lua.global.set(
    "__scryer_frame_get_child_at",
    (id: unknown, index: unknown): number | undefined => {
      const node = registry.getFrame(toNum(id)!);
      const i = toNum(index) ?? 0;
      return node?.childIds[i];
    },
  );

  lua.global.set("__scryer_tex_set_parent_key", (id: unknown, key: unknown): void => {
    const tex = registry.getTexture(toNum(id)!);
    if (tex && typeof key === "string") tex.parentKey = key;
  });

  lua.global.set(
    "__scryer_frame_create_texture",
    (id: unknown, name: unknown, layer: unknown, subLevel: unknown): number | undefined => {
      const tex = registry.createTexture(
        toNum(id)!,
        typeof name === "string" ? name : null,
        typeof layer === "string" ? layer : "ARTWORK",
        toNum(subLevel) ?? 0,
      );
      return tex?.id;
    },
  );

  lua.global.set(
    "__scryer_frame_create_fontstring",
    (id: unknown, name: unknown, layer: unknown): number | undefined => {
      const fs = registry.createFontString(
        toNum(id)!,
        typeof name === "string" ? name : null,
        typeof layer === "string" ? layer : "OVERLAY",
      );
      return fs?.id;
    },
  );

  // ── Button helpers ─────────────────────────────────────────────────────────

  lua.global.set("__scryer_btn_set_text", (id: unknown, text: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.buttonText = typeof text === "string" ? text : undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_btn_get_text", (id: unknown): string | undefined => {
    return registry.getFrame(toNum(id)!)?.buttonText;
  });

  lua.global.set("__scryer_btn_set_normal_texture", (id: unknown, path: unknown): void => {
    // Store as a texture node in ARTWORK layer — simple representation for M7
    const node = registry.getFrame(toNum(id)!);
    if (!node || typeof path !== "string") return;
    const existing = node.textures.find((t) => t.name === "__normalTex__");
    if (existing) {
      existing.file = path;
    } else {
      const tex = registry.createTexture(toNum(id)!, "__normalTex__", "ARTWORK", 0);
      if (tex) tex.file = path;
    }
    registry.markDirty();
  });

  lua.global.set("__scryer_btn_enable", (id: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.enabled = true;
    registry.markDirty();
  });

  lua.global.set("__scryer_btn_disable", (id: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.enabled = false;
    registry.markDirty();
  });

  lua.global.set("__scryer_btn_is_enabled", (id: unknown): boolean => {
    return registry.getFrame(toNum(id)!)?.enabled ?? true;
  });

  // ── StatusBar helpers ──────────────────────────────────────────────────────

  lua.global.set("__scryer_sb_set_minmax", (id: unknown, mn: unknown, mx: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.statusBarMinValue = toNum(mn) ?? 0;
    node.statusBarMaxValue = toNum(mx) ?? 1;
    registry.markDirty();
  });

  lua.global.set("__scryer_sb_get_min", (id: unknown): number => {
    return registry.getFrame(toNum(id)!)?.statusBarMinValue ?? 0;
  });

  lua.global.set("__scryer_sb_get_max", (id: unknown): number => {
    return registry.getFrame(toNum(id)!)?.statusBarMaxValue ?? 1;
  });

  lua.global.set("__scryer_sb_set_value", (id: unknown, v: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.statusBarValue = toNum(v) ?? 0;
    registry.markDirty();
  });

  lua.global.set("__scryer_sb_get_value", (id: unknown): number => {
    return registry.getFrame(toNum(id)!)?.statusBarValue ?? 0;
  });

  lua.global.set("__scryer_sb_set_texture", (id: unknown, path: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.statusBarTexturePath = typeof path === "string" ? path : undefined;
    registry.markDirty();
  });

  lua.global.set(
    "__scryer_sb_set_color",
    (id: unknown, r: unknown, g: unknown, b: unknown, a: unknown): void => {
      const node = registry.getFrame(toNum(id)!);
      if (!node) return;
      node.statusBarColor = {
        r: clamp01(toNum(r) ?? 1),
        g: clamp01(toNum(g) ?? 1),
        b: clamp01(toNum(b) ?? 1),
        a: clamp01(toNum(a) ?? 1),
      };
      registry.markDirty();
    },
  );

  lua.global.set("__scryer_sb_set_orientation", (id: unknown, o: unknown): void => {
    const node = registry.getFrame(toNum(id)!);
    if (!node) return;
    node.statusBarOrientation = typeof o === "string" ? o : "HORIZONTAL";
    registry.markDirty();
  });

  // ── Texture helpers ────────────────────────────────────────────────────────

  const tex = (id: unknown): TextureNode | undefined => registry.getTexture(toNum(id)!);

  lua.global.set("__scryer_tex_set_texture", (id: unknown, path: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.file = typeof path === "string" ? path : undefined;
    t.color = undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_tex_get_texture", (id: unknown): string | undefined => {
    return tex(id)?.file;
  });

  lua.global.set(
    "__scryer_tex_set_atlas",
    (id: unknown, atlas: unknown, useAtlasSize: unknown): void => {
      const t = tex(id);
      if (!t) return;
      t.atlas = typeof atlas === "string" ? atlas : undefined;
      t.useAtlasSize = useAtlasSize === true;
      if (t.useAtlasSize && t.atlas && atlasManifest) {
        const sz = lookupAtlasSize(t.atlas, atlasManifest);
        if (sz) t.size = { x: sz.w, y: sz.h };
      }
      registry.markDirty();
    },
  );

  lua.global.set("__scryer_tex_get_width", (id: unknown): number => {
    return tex(id)?.size?.x ?? 0;
  });

  lua.global.set("__scryer_tex_get_height", (id: unknown): number => {
    return tex(id)?.size?.y ?? 0;
  });

  lua.global.set(
    "__scryer_tex_set_texcoord",
    (
      id: unknown,
      ULx: unknown,
      ULy: unknown,
      LLx: unknown,
      LLy: unknown,
      URx: unknown,
      URy: unknown,
      LRx: unknown,
      LRy: unknown,
    ): void => {
      const t = tex(id);
      if (!t) return;
      // Convert 8-point UL/LL/UR/LR form to simple left/right/top/bottom rect
      // (valid only for axis-aligned rects; rotated texcoords not supported)
      t.texCoords = {
        left: toNum(ULx) ?? 0,
        right: toNum(URx) ?? 1,
        top: toNum(ULy) ?? 0,
        bottom: toNum(LLy) ?? 1,
      };
      registry.markDirty();
    },
  );

  lua.global.set(
    "__scryer_tex_set_vertex_color",
    (id: unknown, r: unknown, g: unknown, b: unknown, a: unknown): void => {
      const t = tex(id);
      if (!t) return;
      t.color = {
        r: clamp01(toNum(r) ?? 1),
        g: clamp01(toNum(g) ?? 1),
        b: clamp01(toNum(b) ?? 1),
        a: clamp01(toNum(a) ?? 1),
      };
      registry.markDirty();
    },
  );

  lua.global.set(
    "__scryer_tex_set_color_texture",
    (id: unknown, r: unknown, g: unknown, b: unknown, a: unknown): void => {
      const t = tex(id);
      if (!t) return;
      t.file = undefined;
      t.atlas = undefined;
      t.color = {
        r: clamp01(toNum(r) ?? 1),
        g: clamp01(toNum(g) ?? 1),
        b: clamp01(toNum(b) ?? 1),
        a: clamp01(toNum(a) ?? 1),
      };
      registry.markDirty();
    },
  );

  lua.global.set("__scryer_tex_set_mask_file", (id: unknown, path: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.maskFile = typeof path === "string" ? path : undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_tex_set_blend_mode", (id: unknown, mode: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.alphaMode = typeof mode === "string" ? mode : undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_tex_set_horiz_tile", (id: unknown, v: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.horizTile = v !== false && v != null ? true : false;
    registry.markDirty();
  });

  lua.global.set("__scryer_tex_set_vert_tile", (id: unknown, v: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.vertTile = v !== false && v != null ? true : false;
    registry.markDirty();
  });

  lua.global.set(
    "__scryer_tex_set_draw_layer",
    (id: unknown, layer: unknown, subLevel: unknown): void => {
      const t = tex(id);
      if (!t) return;
      if (typeof layer === "string") t.layer = layer;
      if (typeof subLevel === "number") t.subLevel = subLevel;
      registry.markDirty();
    },
  );

  lua.global.set("__scryer_tex_set_alpha", (id: unknown, a: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.alpha = clamp01(toNum(a) ?? 1);
    registry.markDirty();
  });

  lua.global.set("__scryer_tex_get_alpha", (id: unknown): number => {
    return tex(id)?.alpha ?? 1;
  });

  lua.global.set("__scryer_tex_show", (id: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.shown = true;
    registry.markDirty();
  });

  lua.global.set("__scryer_tex_hide", (id: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.shown = false;
    registry.markDirty();
  });

  lua.global.set("__scryer_tex_is_shown", (id: unknown): boolean => {
    return tex(id)?.shown ?? false;
  });

  lua.global.set("__scryer_tex_set_size", (id: unknown, w: unknown, h: unknown): void => {
    const t = tex(id);
    if (!t) return;
    sizeNode(t, w, h);
    registry.markDirty();
  });

  lua.global.set(
    "__scryer_tex_set_point",
    (
      id: unknown,
      point: unknown,
      relTo: unknown,
      relPoint: unknown,
      x: unknown,
      y: unknown,
    ): void => {
      const t = tex(id);
      if (!t) return;
      pushAnchor(t.anchors, point, relTo, relPoint, x, y, registry);
      registry.markDirty();
    },
  );

  lua.global.set("__scryer_tex_clear_points", (id: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.anchors = [];
    t.setAllPoints = undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_tex_set_all_points", (id: unknown, relTo: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.anchors = [];
    t.setAllPoints = true;
    const relativeTo = resolveRelTo(relTo, registry);
    if (relativeTo) {
      t.anchors.push({ point: "TOPLEFT", relativeTo, relativePoint: "TOPLEFT", x: 0, y: 0 });
      t.anchors.push({
        point: "BOTTOMRIGHT",
        relativeTo,
        relativePoint: "BOTTOMRIGHT",
        x: 0,
        y: 0,
      });
    }
    registry.markDirty();
  });

  // ── FontString helpers ─────────────────────────────────────────────────────

  const fs = (id: unknown): FontStringNode | undefined => registry.getFontString(toNum(id)!);

  lua.global.set("__scryer_fs_set_text", (id: unknown, text: unknown): void => {
    const f = fs(id);
    if (!f) return;
    f.text = typeof text === "string" ? text : undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_fs_get_text", (id: unknown): string | undefined => {
    return fs(id)?.text;
  });

  lua.global.set(
    "__scryer_fs_set_color",
    (id: unknown, r: unknown, g: unknown, b: unknown, a: unknown): void => {
      const f = fs(id);
      if (!f) return;
      f.color = {
        r: clamp01(toNum(r) ?? 1),
        g: clamp01(toNum(g) ?? 1),
        b: clamp01(toNum(b) ?? 1),
        a: clamp01(toNum(a) ?? 1),
      };
      registry.markDirty();
    },
  );

  lua.global.set(
    "__scryer_fs_get_color",
    (id: unknown): { r: number; g: number; b: number; a: number } | undefined => {
      return fs(id)?.color;
    },
  );

  lua.global.set(
    "__scryer_fs_set_font",
    (id: unknown, path: unknown, size: unknown, _flags: unknown): void => {
      const f = fs(id);
      if (!f) return;
      f.font = typeof path === "string" ? path : undefined;
      f.fontSize = toNum(size);
      registry.markDirty();
    },
  );

  lua.global.set("__scryer_fs_set_justifyh", (id: unknown, j: unknown): void => {
    const f = fs(id);
    if (!f) return;
    f.justifyH = typeof j === "string" ? j : undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_fs_set_justifyv", (id: unknown, j: unknown): void => {
    const f = fs(id);
    if (!f) return;
    f.justifyV = typeof j === "string" ? j : undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_fs_set_alpha", (id: unknown, a: unknown): void => {
    const f = fs(id);
    if (!f) return;
    f.alpha = clamp01(toNum(a) ?? 1);
    registry.markDirty();
  });

  lua.global.set("__scryer_fs_show", (id: unknown): void => {
    const f = fs(id);
    if (!f) return;
    f.shown = true;
    registry.markDirty();
  });

  lua.global.set("__scryer_fs_hide", (id: unknown): void => {
    const f = fs(id);
    if (!f) return;
    f.shown = false;
    registry.markDirty();
  });

  lua.global.set("__scryer_fs_is_shown", (id: unknown): boolean => {
    return fs(id)?.shown ?? false;
  });

  lua.global.set("__scryer_fs_set_size", (id: unknown, w: unknown, h: unknown): void => {
    const f = fs(id);
    if (!f) return;
    sizeNode(f, w, h);
    registry.markDirty();
  });

  lua.global.set(
    "__scryer_fs_set_point",
    (
      id: unknown,
      point: unknown,
      relTo: unknown,
      relPoint: unknown,
      x: unknown,
      y: unknown,
    ): void => {
      const f = fs(id);
      if (!f) return;
      pushAnchor(f.anchors, point, relTo, relPoint, x, y, registry);
      registry.markDirty();
    },
  );

  lua.global.set("__scryer_fs_clear_points", (id: unknown): void => {
    const f = fs(id);
    if (!f) return;
    f.anchors = [];
    f.setAllPoints = undefined;
    registry.markDirty();
  });

  lua.global.set("__scryer_fs_set_all_points", (id: unknown, relTo: unknown): void => {
    const f = fs(id);
    if (!f) return;
    f.anchors = [];
    f.setAllPoints = true;
    const relativeTo = resolveRelTo(relTo, registry);
    if (relativeTo) {
      f.anchors.push({ point: "TOPLEFT", relativeTo, relativePoint: "TOPLEFT", x: 0, y: 0 });
      f.anchors.push({
        point: "BOTTOMRIGHT",
        relativeTo,
        relativePoint: "BOTTOMRIGHT",
        x: 0,
        y: 0,
      });
    }
    registry.markDirty();
  });

  // ── Bootstrap Lua class ────────────────────────────────────────────────────
  await lua.doString(frameClassLua);

  // GameTooltip and GlueTooltip are C-layer frame globals. Create them after
  // frame-class.lua so CreateFrame is available. GetAppropriateTooltip() (from
  // Blizzard_SharedXMLBase/FrameUtil.lua) returns GameTooltip, so it must exist
  // or any OnEnter/OnLeave that calls tooltip:Hide() etc. will crash.
  await lua.doString(`
    GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
    GlueTooltip = GameTooltip
  `);
}
