export interface AddonListFile {
  /** Display name shown in the panel title. */
  name?: string;
  /** Addon directory names to load in order (no .toc extension). */
  addons: string[];
}

/** Strip line comments (`//`) and block comments (slash-star ... star-slash) from a JSONC string. */
function stripJsoncComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\" && i + 1 < text.length) {
        out += ch + text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Parse the contents of a `.addonlist` JSONC file.
 * Throws if the content is not valid JSON (after comment-stripping) or if
 * the required `addons` array is missing.
 */
export function parseAddonList(content: string, filePath: string): AddonListFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncComments(content));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath}: expected a JSON object at top level`);
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj["addons"])) {
    throw new Error(`${filePath}: missing required "addons" array`);
  }

  const addons: string[] = [];
  for (const entry of obj["addons"] as unknown[]) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`${filePath}: "addons" entries must be non-empty strings`);
    }
    addons.push(entry.trim());
  }

  const name = typeof obj["name"] === "string" ? obj["name"] : undefined;

  return { name, addons };
}
