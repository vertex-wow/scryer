import { type LuaEngine } from "wasmoon";
import frameClassLua from "./frame-class.lua";
import { FrameRegistry } from "./frame-registry.js";
import type { FrameNode, TextureNode, FontStringNode, AnchorDef } from "./frame-model.js";

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

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Inject the WoW frame object model into an existing M5+M6 sandbox.
 * Creates UIParent/WorldFrame, registers CreateFrame and all widget methods,
 * and bootstraps the Lua class metatables.
 *
 * Must be called after registerWowApi().
 */
export async function registerFrameModel(lua: LuaEngine, registry: FrameRegistry): Promise<void> {
  // ── UIParent / WorldFrame IDs ──────────────────────────────────────────────
  // Expose as globals so frame-class.lua can capture them as upvalues.
  lua.global.set("__scryer_ui_parent_id", registry.uiParentId);
  lua.global.set("__scryer_world_frame_id", registry.worldFrameId);

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
      registry.markDirty();
    },
  );

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

  lua.global.set("__scryer_tex_set_blend_mode", (id: unknown, mode: unknown): void => {
    const t = tex(id);
    if (!t) return;
    t.alphaMode = typeof mode === "string" ? mode : undefined;
    registry.markDirty();
  });

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
}
