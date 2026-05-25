export interface TocFile {
  interfaceVersions: number[];
  metadata: Record<string, string>;
  files: string[];
}

export function parseToc(content: string): TocFile {
  const result: TocFile = {
    interfaceVersions: [],
    metadata: {},
    files: [],
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("##")) {
      const rest = line.slice(2).trim();
      const colonIdx = rest.indexOf(":");
      if (colonIdx === -1) continue;
      const key = rest.slice(0, colonIdx).trim();
      const value = rest.slice(colonIdx + 1).trim();
      result.metadata[key] = value;

      if (key === "Interface") {
        result.interfaceVersions = value
          .split(",")
          .map((v) => parseInt(v.trim(), 10))
          .filter((n) => !isNaN(n));
      }
    } else if (!line.startsWith("#")) {
      result.files.push(line.replace(/\\/g, "/"));
    }
  }

  return result;
}
