// Vitest counterpart to vscode.ts. Uses named exports so `import * as vscode`
// resolves correctly under ESM. Keep in sync with vscode.ts.
import { vi } from "vitest";

export const window = {
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  createWebviewPanel: vi.fn(),
};

export const workspace = {
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn(),
  }),
  onDidSaveTextDocument: vi.fn(),
  onDidChangeTextDocument: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn(),
};

export const Uri = {
  file: vi.fn((path: string) => ({ fsPath: path })),
  joinPath: vi.fn(),
};

export const ViewColumn = { One: 1, Two: 2, Three: 3 };
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
