export interface TocFile {
  interfaceVersions: number[];
  title: string;
  version?: string;
  savedVariables: string[];
  savedVariablesPerChar: string[];
  files: { path: string; type: "lua" | "xml" }[];
  rawMeta: Record<string, string>;
  sourceFile: string;
}

/** Returns true if the content looks like a WoW TOC (lightweight pre-parse check). */
export function isTocFile(content: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith("##") && t.toLowerCase().includes("interface") && t.includes(":")) {
      return true;
    }
  }
  return false;
}

export function parseToc(content: string, sourceFile = ""): TocFile {
  const rawMeta: Record<string, string> = {};
  const files: { path: string; type: "lua" | "xml" }[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("##")) {
      const rest = line.slice(2).trim();
      const colonIdx = rest.indexOf(":");
      if (colonIdx === -1) continue;
      const key = rest.slice(0, colonIdx).trim();
      const value = rest.slice(colonIdx + 1).trim();
      rawMeta[key] = value;
    } else if (!line.startsWith("#")) {
      const normalized = line.replace(/\\/g, "/");
      const lower = normalized.toLowerCase();
      const type = lower.endsWith(".lua") ? "lua" : lower.endsWith(".xml") ? "xml" : null;
      if (type) files.push({ path: normalized, type });
    }
  }

  const get = (key: string): string | undefined => {
    const k = Object.keys(rawMeta).find((k) => k.toLowerCase() === key.toLowerCase());
    return k !== undefined ? rawMeta[k] : undefined;
  };

  const interfaceVersions = (get("Interface") ?? "")
    .split(",")
    .map((v) => parseInt(v.trim(), 10))
    .filter((n) => !isNaN(n));

  const savedVariables = (get("SavedVariables") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const savedVariablesPerChar = (get("SavedVariablesPerCharacter") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  return {
    interfaceVersions,
    title: get("Title") ?? "",
    version: get("Version"),
    savedVariables,
    savedVariablesPerChar,
    files,
    rawMeta,
    sourceFile,
  };
}
