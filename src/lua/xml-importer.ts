import { parseXmlFile } from "../parser/xml.js";
import { resolveInheritance } from "../parser/inherit.js";
import type { FontStringIR, FrameIR, ScriptIR, TextureIR, UiDocument } from "../parser/ir.js";
import type { LuaEngine } from "wasmoon";

export interface ImportContext {
  /** Templates accumulated from this addon's own XML files (updated in-place). */
  addonTemplates: Map<string, FrameIR>;
  /** Pre-loaded Blizzard virtual template registry, or undefined if not available. */
  blizzardTemplates: Map<string, FrameIR> | undefined;
  output: { warn: (msg: string) => void; error: (msg: string) => void };
}

// ─── Code generation ──────────────────────────────────────────────────────────

// Monotonically increasing counter for unique Lua variable names within a session.
let _varCounter = 0;

function freshId(): number {
  return _varCounter++;
}

function emitAnchorCode(
  varName: string,
  ir: { anchors: FrameIR["anchors"]; setAllPoints?: boolean },
  parentExpr: string,
  lines: string[],
): void {
  if (ir.setAllPoints) {
    const relTo = ir.anchors[0]?.relativeTo ?? ir.anchors[0]?.relativeKey;
    lines.push(`${varName}:SetAllPoints(${relTo ? JSON.stringify(relTo) : parentExpr})`);
    return;
  }
  for (const a of ir.anchors) {
    const relTo = a.relativeTo ?? a.relativeKey;
    const relToExpr = relTo ? JSON.stringify(relTo) : parentExpr;
    const relPoint = a.relativePoint ? JSON.stringify(a.relativePoint) : "nil";
    const x = a.x ?? 0;
    const y = a.y ?? 0;
    lines.push(
      `${varName}:SetPoint(${JSON.stringify(a.point)}, ${relToExpr}, ${relPoint}, ${x}, ${y})`,
    );
  }
}

function emitScriptCode(
  varName: string,
  script: ScriptIR,
  lines: string[],
  scriptBodies: string[],
): void {
  if (script.inline) {
    // Inject the script body via a temporary Lua global to avoid all quoting issues.
    // The global is set in TS before doString runs and nil'd out in Lua right after load().
    // Named params (event, arg1..arg9) match WoW XML OnEvent/OnLoad conventions.
    const idx = scriptBodies.length;
    scriptBodies.push(
      `return function(self, event, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) ${script.inline} end`,
    );
    lines.push(`do`);
    lines.push(`  local _src = __xs${idx}`);
    lines.push(`  __xs${idx} = nil`); // nil out in Lua to avoid leaving globals around
    lines.push(`  local _fn, _err = load(_src)`);
    lines.push(
      `  if _fn then ${varName}:SetScript(${JSON.stringify(script.event)}, _fn())` +
        ` elseif _err then print("[Scryer] XML script compile error: " .. tostring(_err)) end`,
    );
    lines.push(`end`);
  } else if (script.function) {
    // Reference to a named global function
    lines.push(`${varName}:SetScript(${JSON.stringify(script.event)}, ${script.function})`);
  } else if (script.method) {
    // method="OnLoad" → delegate to self:Method() when the script fires.
    // Used by Blizzard mixin templates (e.g. <OnLoad method="OnLoad"/> in NineSliceCodeTemplate).
    // HookScript so the method call stacks with any previously-registered handlers rather than
    // replacing them.
    const m = script.method;
    lines.push(
      `${varName}:HookScript(${JSON.stringify(script.event)}, function(self, ...) if type(self.${m}) == "function" then self:${m}(...) end end)`,
    );
  }
}

function generateTextureCode(
  parentVar: string,
  tex: TextureIR,
  layer: string,
  subLevel: number,
  lines: string[],
): void {
  const id = freshId();
  const v = `__xt${id}`;
  const quotedName = tex.name ? JSON.stringify(tex.name) : "nil";
  lines.push(
    `local ${v} = ${parentVar}:CreateTexture(${quotedName}, ${JSON.stringify(layer)}, nil, ${subLevel})`,
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
  emitAnchorCode(`  ${v}`, tex, parentVar, lines);
  if (tex.maskFile) lines.push(`  ${v}:__SetMaskFile(${JSON.stringify(tex.maskFile)})`);
  if (tex.parentKey) {
    lines.push(`  ${parentVar}.${tex.parentKey} = ${v}`);
    lines.push(
      `  if __scryer_tex_set_parent_key then __scryer_tex_set_parent_key(${v}.__id, ${JSON.stringify(tex.parentKey)}) end`,
    );
  }
  if (tex.parentArray) {
    lines.push(`  ${parentVar}.${tex.parentArray} = ${parentVar}.${tex.parentArray} or {}`);
    lines.push(`  table.insert(${parentVar}.${tex.parentArray}, ${v})`);
  }
  lines.push(`end`);
}

function generateFontStringCode(
  parentVar: string,
  fs: FontStringIR,
  layer: string,
  lines: string[],
): void {
  const id = freshId();
  const v = `__xfs${id}`;
  const quotedName = fs.name ? JSON.stringify(fs.name) : "nil";
  lines.push(`local ${v} = ${parentVar}:CreateFontString(${quotedName}, ${JSON.stringify(layer)})`);
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
  emitAnchorCode(`  ${v}`, fs, parentVar, lines);
  if (fs.parentKey) lines.push(`  ${parentVar}.${fs.parentKey} = ${v}`);
  if (fs.parentArray) {
    lines.push(`  ${parentVar}.${fs.parentArray} = ${parentVar}.${fs.parentArray} or {}`);
    lines.push(`  table.insert(${parentVar}.${fs.parentArray}, ${v})`);
  }
  lines.push(`end`);
}

function generateFrameCode(
  frame: FrameIR,
  parentExpr: string,
  lines: string[],
  scriptBodies: string[],
): void {
  const id = freshId();
  const v = `__xf${id}`;
  const quotedName = frame.name ? JSON.stringify(frame.name) : "nil";

  lines.push(
    `local ${v} = CreateFrame(${JSON.stringify(frame.kind)}, ${quotedName}, ${parentExpr})`,
  );
  lines.push(`if ${v} then`);

  if (frame.size?.x !== undefined || frame.size?.y !== undefined)
    lines.push(`  ${v}:SetSize(${frame.size?.x ?? 0}, ${frame.size?.y ?? 0})`);
  if (frame.hidden) lines.push(`  ${v}:Hide()`);
  if (frame.alpha !== undefined) lines.push(`  ${v}:SetAlpha(${frame.alpha})`);
  if (frame.scale !== undefined) lines.push(`  ${v}:SetScale(${frame.scale})`);
  if (frame.frameStrata) lines.push(`  ${v}:SetFrameStrata(${JSON.stringify(frame.frameStrata)})`);
  if (frame.frameLevel !== undefined) lines.push(`  ${v}:SetFrameLevel(${frame.frameLevel})`);
  if (frame.useParentLevel) lines.push(`  ${v}:SetAttribute("__scryer_useParentLevel", true)`);

  // Anchors (indented lines need the prefix handled carefully — emit as top-level within if block)
  const anchorLines: string[] = [];
  emitAnchorCode(v, frame, parentExpr, anchorLines);
  for (const l of anchorLines) lines.push(`  ${l}`);

  // Apply mixins before layers/scripts so mixin methods are available to OnLoad
  if (frame.mixin.length > 0) {
    lines.push(`  Mixin(${v}, ${frame.mixin.join(", ")})`);
  }

  // KeyValues: assign on the frame object so Lua code can read them (e.g. self.layoutType)
  for (const kv of frame.keyValues) {
    const key = JSON.stringify(kv.key);
    let luaVal: string;
    switch (kv.type) {
      case "string":
        luaVal = JSON.stringify(kv.value);
        break;
      case "number":
        luaVal = kv.value;
        break;
      case "boolean":
        luaVal = kv.value === "true" ? "true" : "false";
        break;
      case "nil":
        luaVal = "nil";
        break;
      case "global":
        luaVal = kv.value;
        break;
      default:
        continue;
    }
    lines.push(`  ${v}[${key}] = ${luaVal}`);
  }

  // Layers: textures and font strings
  for (const layer of frame.layers) {
    for (const obj of layer.objects) {
      const objLines: string[] = [];
      if (obj.kind === "Texture" || obj.kind === "MaskTexture") {
        generateTextureCode(v, obj as TextureIR, layer.level, layer.subLevel, objLines);
      } else if (obj.kind === "FontString") {
        generateFontStringCode(v, obj as FontStringIR, layer.level, objLines);
      }
      for (const l of objLines) lines.push(`  ${l}`);
    }
  }

  // SetText after layers so self.Text FontString exists before the call
  if (frame.text !== undefined) lines.push(`  ${v}:SetText(${JSON.stringify(frame.text)})`);

  // Non-OnLoad scripts registered before children are created
  const onLoadScripts: ScriptIR[] = [];
  for (const script of frame.scripts) {
    if (script.event === "OnLoad") {
      onLoadScripts.push(script);
    } else {
      const scriptLines: string[] = [];
      emitScriptCode(v, script, scriptLines, scriptBodies);
      for (const l of scriptLines) lines.push(`  ${l}`);
    }
  }

  // Children (their OnLoad fires before the parent's)
  for (const child of frame.children) {
    if (!child.virtual) {
      const childLines: string[] = [];
      generateFrameCode(child, v, childLines, scriptBodies);
      for (const l of childLines) lines.push(`  ${l}`);
    }
  }

  // Register OnLoad scripts, then fire immediately (mirrors WoW XML load behaviour).
  // __scryer_dispatch_script fires all handlers in the chain (including hooks).
  for (const script of onLoadScripts) {
    const scriptLines: string[] = [];
    emitScriptCode(v, script, scriptLines, scriptBodies);
    for (const l of scriptLines) lines.push(`  ${l}`);
  }
  lines.push(
    `  if type(__scryer_dispatch_script) == "function" then __scryer_dispatch_script(${v}.__id, "OnLoad") end`,
  );

  if (frame.parentKey) lines.push(`  ${parentExpr}.${frame.parentKey} = ${v}`);
  if (frame.parentArray) {
    lines.push(`  ${parentExpr}.${frame.parentArray} = ${parentExpr}.${frame.parentArray} or {}`);
    lines.push(`  table.insert(${parentExpr}.${frame.parentArray}, ${v})`);
  }

  lines.push(`end`); // close "if v then"
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse one XML file and instantiate its non-virtual frames into the Lua sandbox
 * via generated CreateFrame calls. Virtual frames (templates) are added to
 * ctx.addonTemplates for use by subsequent XML files in the same addon.
 */
export async function importXmlFile(
  source: string,
  sourceFile: string,
  sandbox: LuaEngine,
  ctx: ImportContext,
): Promise<void> {
  let doc: UiDocument;
  try {
    doc = parseXmlFile(sourceFile, source);
  } catch (e) {
    ctx.output.error(`[XML] Parse error in ${sourceFile}: ${e}`);
    return;
  }

  // Accumulate addon templates from this file for use in later XML files
  for (const [name, tpl] of doc.templates) {
    ctx.addonTemplates.set(name, tpl);
  }

  // Resolve inheritance: blizzard templates + previously-seen addon templates + this doc
  const allTemplates = new Map([...(ctx.blizzardTemplates ?? new Map()), ...ctx.addonTemplates]);
  const pseudoTemplateDoc: UiDocument = {
    source: "",
    frames: [],
    templates: allTemplates,
    scriptFiles: [],
    includes: [],
  };
  const [, resolved] = resolveInheritance([pseudoTemplateDoc, doc]);

  const nonVirtual = resolved.frames.filter((f) => !f.virtual);
  if (nonVirtual.length === 0) return;

  const lines: string[] = [];
  const scriptBodies: string[] = [];

  for (const frame of nonVirtual) {
    generateFrameCode(frame, "UIParent", lines, scriptBodies);
  }

  // Inject script body strings as Lua globals before running the generated code
  for (let i = 0; i < scriptBodies.length; i++) {
    sandbox.global.set(`__xs${i}`, scriptBodies[i]);
  }

  try {
    await sandbox.doString(lines.join("\n"));
  } catch (e) {
    ctx.output.error(`[XML] Runtime error in ${sourceFile}: ${e}`);
  }
}
