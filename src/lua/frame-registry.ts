import type { FrameIR } from "../parser/ir.js";
import {
  makeFrameNode,
  makeTextureNode,
  makeFontStringNode,
  frameNodeToIR,
  type FrameNode,
  type TextureNode,
  type FontStringNode,
} from "./frame-model.js";

export class FrameRegistry {
  private _nextId = 1;
  private _frameNodes = new Map<number, FrameNode>();
  private _textureNodes = new Map<number, { owner: FrameNode; node: TextureNode }>();
  private _fontStringNodes = new Map<number, { owner: FrameNode; node: FontStringNode }>();
  private _nameIndex = new Map<string, number>(); // name → frameId
  private _dirty = false;
  readonly uiParentId: number;
  readonly worldFrameId: number;

  constructor(uiParentWidth: number, uiParentHeight: number) {
    // Pre-create UIParent
    const uiParent = this._allocFrame("Frame", "UIParent");
    uiParent.width = uiParentWidth;
    uiParent.height = uiParentHeight;
    uiParent.anchors = [{ point: "TOPLEFT", x: 0, y: 0 }];
    this.uiParentId = uiParent.id;

    // Pre-create WorldFrame as a child of UIParent
    const worldFrame = this._allocFrame("Frame", "WorldFrame", uiParent.id);
    worldFrame.setAllPoints = true;
    uiParent.childIds.push(worldFrame.id);
    this.worldFrameId = worldFrame.id;

    this._dirty = false; // reset — bootstrap nodes don't count as mutations
  }

  // ─── Node allocation ────────────────────────────────────────────────────────

  private _allocFrame(type: string, name?: string, parentId?: number): FrameNode {
    const id = this._nextId++;
    const node = makeFrameNode(id, type);
    node.name = name;
    node.parentId = parentId;
    this._frameNodes.set(id, node);
    if (name) this._nameIndex.set(name, id);
    return node;
  }

  createFrame(frameType: string, name?: string | null, parentId?: number | null): FrameNode {
    const resolvedParent = parentId ?? this.uiParentId;
    const node = this._allocFrame(
      frameType,
      typeof name === "string" && name.length > 0 ? name : undefined,
      resolvedParent,
    );
    // Register as a child of the parent
    const parentNode = this._frameNodes.get(resolvedParent);
    if (parentNode) parentNode.childIds.push(node.id);
    this._dirty = true;
    return node;
  }

  createTexture(
    frameId: number,
    name?: string | null,
    layer = "ARTWORK",
    subLevel = 0,
  ): TextureNode | undefined {
    const owner = this._frameNodes.get(frameId);
    if (!owner) return undefined;
    const id = this._nextId++;
    const node = makeTextureNode(id, layer, subLevel);
    if (typeof name === "string" && name.length > 0) node.name = name;
    owner.textures.push(node);
    this._textureNodes.set(id, { owner, node });
    this._dirty = true;
    return node;
  }

  createFontString(
    frameId: number,
    name?: string | null,
    layer = "OVERLAY",
  ): FontStringNode | undefined {
    const owner = this._frameNodes.get(frameId);
    if (!owner) return undefined;
    const id = this._nextId++;
    const node = makeFontStringNode(id, layer);
    if (typeof name === "string" && name.length > 0) node.name = name;
    owner.fontStrings.push(node);
    this._fontStringNodes.set(id, { owner, node });
    this._dirty = true;
    return node;
  }

  // ─── Lookups ────────────────────────────────────────────────────────────────

  getFrame(id: number): FrameNode | undefined {
    return this._frameNodes.get(id);
  }

  getTexture(id: number): TextureNode | undefined {
    return this._textureNodes.get(id)?.node;
  }

  getFontString(id: number): FontStringNode | undefined {
    return this._fontStringNodes.get(id)?.node;
  }

  getFrameByName(name: string): FrameNode | undefined {
    const id = this._nameIndex.get(name);
    return id !== undefined ? this._frameNodes.get(id) : undefined;
  }

  // ─── Parent management ──────────────────────────────────────────────────────

  reparent(frameId: number, newParentId: number | null): void {
    const node = this._frameNodes.get(frameId);
    if (!node) return;
    // Remove from old parent's childIds
    if (node.parentId !== undefined) {
      const oldParent = this._frameNodes.get(node.parentId);
      if (oldParent) {
        oldParent.childIds = oldParent.childIds.filter((id) => id !== frameId);
      }
    }
    // Add to new parent
    const resolved = newParentId ?? this.uiParentId;
    node.parentId = resolved;
    const newParent = this._frameNodes.get(resolved);
    if (newParent && !newParent.childIds.includes(frameId)) {
      newParent.childIds.push(frameId);
    }
    this._dirty = true;
  }

  // ─── Dirty flag ─────────────────────────────────────────────────────────────

  markDirty(): void {
    this._dirty = true;
  }

  isDirty(): boolean {
    return this._dirty;
  }

  clearDirty(): void {
    this._dirty = false;
  }

  // ─── Serialization ──────────────────────────────────────────────────────────

  /** Serialize the frame tree rooted at UIParent's children to FrameIR[]. */
  serialize(): FrameIR[] {
    const uiParent = this._frameNodes.get(this.uiParentId);
    if (!uiParent) return [];
    const getter = (id: number) => this._frameNodes.get(id);
    return uiParent.childIds
      .map((id) => this._frameNodes.get(id))
      .filter((n): n is FrameNode => n !== undefined)
      .map((node) => frameNodeToIR(node, getter, this.uiParentId));
  }

  /** Resolve a SetPoint relTo: number ID → frame name, string → as-is. */
  resolveRelTo(relToIdOrName: number | string | null | undefined): string | undefined {
    if (typeof relToIdOrName === "number") {
      return this._frameNodes.get(relToIdOrName)?.name;
    }
    if (typeof relToIdOrName === "string") return relToIdOrName;
    return undefined;
  }
}
