import type {
  DrawLayer,
  FontStringIR,
  FrameIR,
  KeyValue,
  RenderObjectIR,
  ScriptIR,
  TextureIR,
  UiDocument,
} from "./ir.js";

// ---------------------------------------------------------------------------
// Deep-clone helpers (keep IR immutable during merge)
// ---------------------------------------------------------------------------

function cloneTexture(t: TextureIR): TextureIR {
  return {
    ...t,
    anchors: t.anchors.map((a) => ({ ...a })),
    keyValues: t.keyValues.map((kv) => ({ ...kv })),
    ...(t.texCoords ? { texCoords: { ...t.texCoords } } : {}),
    ...(t.color ? { color: { ...t.color } } : {}),
  };
}

function cloneFontString(fs: FontStringIR): FontStringIR {
  return {
    ...fs,
    anchors: fs.anchors.map((a) => ({ ...a })),
    keyValues: fs.keyValues.map((kv) => ({ ...kv })),
    ...(fs.color ? { color: { ...fs.color } } : {}),
  };
}

function cloneRenderObject(obj: RenderObjectIR): RenderObjectIR {
  if (obj.kind === "FontString") return cloneFontString(obj);
  return cloneTexture(obj as TextureIR);
}

function cloneFrame(f: FrameIR): FrameIR {
  return {
    ...f,
    inherits: [...f.inherits],
    mixin: [...f.mixin],
    anchors: f.anchors.map((a) => ({ ...a })),
    keyValues: f.keyValues.map((kv) => ({ ...kv })),
    layers: f.layers.map((l) => ({
      ...l,
      objects: l.objects.map(cloneRenderObject),
    })),
    children: f.children.map(cloneFrame),
    scripts: f.scripts.map((s) => ({ ...s })),
    templateChain: [...f.templateChain],
    ...(f.normalTexture ? { normalTexture: cloneTexture(f.normalTexture) } : {}),
    ...(f.pushedTexture ? { pushedTexture: cloneTexture(f.pushedTexture) } : {}),
    ...(f.disabledTexture ? { disabledTexture: cloneTexture(f.disabledTexture) } : {}),
    ...(f.highlightTexture ? { highlightTexture: cloneTexture(f.highlightTexture) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

function mergeKeyValues(base: KeyValue[], override: KeyValue[]): KeyValue[] {
  const map = new Map<string, KeyValue>(base.map((kv) => [kv.key, kv]));
  for (const kv of override) map.set(kv.key, kv);
  return Array.from(map.values());
}

function mergeScripts(base: ScriptIR[], override: ScriptIR[]): ScriptIR[] {
  // Group override scripts by event
  const overrideByEvent = new Map<string, ScriptIR[]>();
  for (const s of override) {
    const arr = overrideByEvent.get(s.event) ?? [];
    arr.push(s);
    overrideByEvent.set(s.event, arr);
  }

  const result: ScriptIR[] = [];

  // Process base scripts, then append/prepend/replace per override
  const processedEvents = new Set<string>();
  for (const baseScript of base) {
    if (processedEvents.has(baseScript.event)) continue;
    processedEvents.add(baseScript.event);

    const overrides = overrideByEvent.get(baseScript.event);
    if (!overrides || overrides.length === 0) {
      result.push({ ...baseScript });
      continue;
    }
    for (const ov of overrides) {
      if (ov.inherit === "none") {
        result.push({ ...ov });
      } else if (ov.inherit === "prepend") {
        result.push({ ...ov });
        result.push({ ...baseScript });
      } else {
        // append (default)
        result.push({ ...baseScript });
        result.push({ ...ov });
      }
    }
  }

  // Add override scripts for events not in base
  for (const [event, overrides] of overrideByEvent) {
    if (!processedEvents.has(event)) {
      for (const ov of overrides) result.push({ ...ov });
    }
  }

  return result;
}

function mergeLayers(base: FrameIR["layers"], override: FrameIR["layers"]): FrameIR["layers"] {
  const byLevel = new Map<DrawLayer, { subLevel: number; objects: RenderObjectIR[] }>();
  for (const layer of base) {
    byLevel.set(layer.level, {
      subLevel: layer.subLevel,
      objects: layer.objects.map(cloneRenderObject),
    });
  }
  for (const layer of override) {
    const existing = byLevel.get(layer.level);
    if (existing) {
      existing.objects = [...existing.objects, ...layer.objects.map(cloneRenderObject)];
    } else {
      byLevel.set(layer.level, {
        subLevel: layer.subLevel,
        objects: layer.objects.map(cloneRenderObject),
      });
    }
  }
  // Preserve DrawLayer order
  const ORDER: DrawLayer[] = ["BACKGROUND", "BORDER", "ARTWORK", "OVERLAY", "HIGHLIGHT"];
  return ORDER.filter((l) => byLevel.has(l)).map((l) => ({
    level: l,
    subLevel: byLevel.get(l)!.subLevel,
    objects: byLevel.get(l)!.objects,
  }));
}

// Merge template into a concrete frame: template is the base, concrete overrides.
// Returns a new FrameIR.
function applyTemplate(concrete: FrameIR, template: FrameIR): FrameIR {
  const result: FrameIR = {
    // Start from template values
    ...cloneFrame(template),
    // Concrete frame's identity fields always win
    name: concrete.name,
    parentKey: concrete.parentKey,
    parentArray: concrete.parentArray,
    virtual: concrete.virtual,
    sourceFile: concrete.sourceFile,
    sourceLine: concrete.sourceLine,
    templateChain: [...template.templateChain, template.name ?? "", ...concrete.templateChain],
    // Concrete inherits list carried forward (already applied above, but preserve for ref)
    inherits: concrete.inherits,
    mixin: [...template.mixin, ...concrete.mixin],
  };

  // Scalar overrides: concrete wins if defined
  if (concrete.kind !== undefined) result.kind = concrete.kind;
  if (concrete.parent !== undefined) result.parent = concrete.parent;
  if (concrete.frameStrata !== undefined) result.frameStrata = concrete.frameStrata;
  if (concrete.frameLevel !== undefined) result.frameLevel = concrete.frameLevel;
  if (concrete.toplevel !== undefined) result.toplevel = concrete.toplevel;
  if (concrete.movable !== undefined) result.movable = concrete.movable;
  if (concrete.resizable !== undefined) result.resizable = concrete.resizable;
  if (concrete.enableMouse !== undefined) result.enableMouse = concrete.enableMouse;
  if (concrete.hidden !== undefined) result.hidden = concrete.hidden;
  if (concrete.alpha !== undefined) result.alpha = concrete.alpha;
  if (concrete.scale !== undefined) result.scale = concrete.scale;
  if (concrete.text !== undefined) result.text = concrete.text;
  if (concrete.buttonText !== undefined) result.buttonText = concrete.buttonText;
  if (concrete.normalFont !== undefined) result.normalFont = concrete.normalFont;
  if (concrete.highlightFont !== undefined) result.highlightFont = concrete.highlightFont;
  if (concrete.disabledFont !== undefined) result.disabledFont = concrete.disabledFont;
  if (concrete.setAllPoints !== undefined) result.setAllPoints = concrete.setAllPoints;
  if (concrete.size !== undefined) result.size = { ...concrete.size };

  // Concrete anchors override entirely if present
  if (concrete.anchors.length > 0) {
    result.anchors = concrete.anchors.map((a) => ({ ...a }));
  }

  // Button textures: concrete wins if defined
  if (concrete.normalTexture !== undefined)
    result.normalTexture = cloneTexture(concrete.normalTexture);
  if (concrete.pushedTexture !== undefined)
    result.pushedTexture = cloneTexture(concrete.pushedTexture);
  if (concrete.disabledTexture !== undefined)
    result.disabledTexture = cloneTexture(concrete.disabledTexture);
  if (concrete.highlightTexture !== undefined)
    result.highlightTexture = cloneTexture(concrete.highlightTexture);

  // Collections: append concrete onto template
  result.keyValues = mergeKeyValues(template.keyValues, concrete.keyValues);
  result.layers = mergeLayers(template.layers, concrete.layers);
  result.scripts = mergeScripts(template.scripts, concrete.scripts);
  result.children = [...template.children.map(cloneFrame), ...concrete.children.map(cloneFrame)];

  return result;
}

// ---------------------------------------------------------------------------
// Resolution pass
// ---------------------------------------------------------------------------

// Expand $parent in a child frame's name given the resolved parent name.
function expandParentName(childName: string, parentName: string): string {
  return childName.replace(/\$parent/gi, parentName);
}

function resolveFrameName(frame: FrameIR, parentName: string): void {
  if (frame.name) {
    frame.name = expandParentName(frame.name, parentName);
  }
  // Recurse into children — each child's $parent is the frame itself
  const myName = frame.name ?? parentName;
  for (const child of frame.children) {
    resolveFrameName(child, myName);
  }
}

function resolveFrame(
  frame: FrameIR,
  registry: Map<string, FrameIR>,
  resolving: Set<string>,
  warnings?: { count: number },
  pending = false,
): FrameIR {
  // Recursively resolve children first (bottom-up)
  frame.children = frame.children.map((c) =>
    resolveFrame(c, registry, resolving, warnings, pending),
  );

  if (frame.inherits.length === 0) return frame;

  // Only named frames can form cycles (anonymous frames have no referenceable identity).
  const frameName = frame.name;
  if (frameName) {
    if (resolving.has(frameName)) {
      console.warn(`[scryer] Circular template inheritance detected at "${frameName}"`);
      return frame;
    }
    resolving.add(frameName);
  }

  // Build merged template base: apply templates left-to-right so that later templates
  // in the list override earlier ones for scalar conflicts (WoW merge semantics).
  let templateBase: FrameIR | null = null;
  for (const templateName of frame.inherits) {
    const tmpl = registry.get(templateName);
    if (!tmpl) {
      if (pending) {
        console.log(
          `[scryer] Template "${templateName}" not found (referenced by "${frameName}") — queued for extraction`,
        );
      } else {
        console.warn(
          `[scryer] Template "${templateName}" not found (referenced by "${frameName}")`,
        );
      }
      if (warnings) warnings.count++;
      continue;
    }
    const resolvedTmpl = resolveFrame(
      cloneFrame(tmpl),
      registry,
      new Set(resolving),
      warnings,
      pending,
    );
    if (templateBase === null) {
      templateBase = resolvedTmpl;
    } else {
      // Later template is the "concrete" so its scalars win over the earlier base
      templateBase = applyTemplate(resolvedTmpl, templateBase);
    }
  }

  if (frameName) resolving.delete(frameName);

  if (templateBase === null) return frame;

  // Apply the original concrete frame on top of the fully merged template base.
  // frame only carries explicitly-set values at this point, so its fields correctly
  // override the template without polluting the inter-template merge above.
  return applyTemplate(frame, templateBase);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resolveInheritance(
  docs: UiDocument[],
  blizzardRegistry: Map<string, FrameIR> = new Map(),
  warnings?: { count: number },
  pending = false,
): UiDocument[] {
  // Build global template registry: blizzard first, then user docs in order
  const registry = new Map<string, FrameIR>(blizzardRegistry);
  for (const doc of docs) {
    for (const [name, frame] of doc.templates) {
      registry.set(name, frame);
    }
  }

  return docs.map((doc) => {
    const resolvedFrames = doc.frames.map((f) => {
      const resolved = resolveFrame(cloneFrame(f), registry, new Set(), warnings, pending);
      // Expand $parent in top-level frames (parent name is empty string — no substitution)
      resolveFrameName(resolved, "");
      return resolved;
    });

    const resolvedTemplates = new Map<string, FrameIR>();
    for (const [name, tmpl] of doc.templates) {
      const resolved = resolveFrame(cloneFrame(tmpl), registry, new Set(), warnings, pending);
      resolvedTemplates.set(name, resolved);
    }

    return {
      ...doc,
      frames: resolvedFrames,
      templates: resolvedTemplates,
    };
  });
}
