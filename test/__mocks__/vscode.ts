// Minimal vscode API stub for Jest tests.
// The real `vscode` module only exists inside the extension host.
// Expand stubs here as tests require specific APIs.

const vscode = {
  window: {
    showErrorMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    createWebviewPanel: jest.fn(),
  },
  workspace: {
    getConfiguration: jest.fn().mockReturnValue({
      get: jest.fn(),
    }),
    onDidSaveTextDocument: jest.fn(),
    onDidChangeTextDocument: jest.fn(),
  },
  commands: {
    registerCommand: jest.fn(),
  },
  Uri: {
    file: jest.fn((path: string) => ({ fsPath: path })),
    joinPath: jest.fn(),
  },
  ViewColumn: { One: 1, Two: 2, Three: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
};

export = vscode;
