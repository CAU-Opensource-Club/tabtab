class DiagnosticsCache {
  constructor({ vscode }) {
    this.vscode = vscode;
    this.cache = new Map();
    this.disposables = [];
  }

  initialize(context) {
    const languages = this.vscode && this.vscode.languages;
    if (!languages || typeof languages.onDidChangeDiagnostics !== "function") {
      return;
    }

    this.disposables.push(
      languages.onDidChangeDiagnostics((event) => {
        for (const uri of event.uris || []) {
          this.refreshUri(uri);
        }
      })
    );

    if (context && Array.isArray(context.subscriptions)) {
      context.subscriptions.push(this);
    }
  }

  dispose() {
    for (const disposable of this.disposables.splice(0)) {
      if (disposable && typeof disposable.dispose === "function") {
        disposable.dispose();
      }
    }
    this.cache.clear();
  }

  getForDocument(document) {
    if (!document || !document.uri || !this.isWorkspaceUri(document.uri)) {
      return [];
    }

    const key = document.uri.toString();
    if (!this.cache.has(key)) {
      this.refreshUri(document.uri);
    }

    return [...(this.cache.get(key) || [])];
  }

  getNearPosition(document, position, beforeLines, afterLines) {
    if (!position) {
      return this.getForDocument(document);
    }

    const start = Math.max(0, position.line - Math.max(0, beforeLines || 0));
    const end = position.line + Math.max(0, afterLines || 0);

    return this.getForDocument(document).filter((diagnostic) => {
      const line = diagnostic.range && diagnostic.range.start
        ? diagnostic.range.start.line
        : 0;
      return line >= start && line <= end;
    });
  }

  refreshUri(uri) {
    if (!uri || !this.isWorkspaceUri(uri)) {
      return;
    }

    const languages = this.vscode && this.vscode.languages;
    const diagnostics = languages && typeof languages.getDiagnostics === "function"
      ? languages.getDiagnostics(uri)
      : [];
    const cached = (diagnostics || [])
      .filter((diagnostic) => isErrorOrWarning(this.vscode, diagnostic))
      .map((diagnostic) => ({
        uri,
        range: diagnostic.range,
        severity: diagnostic.severity,
        source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
        code: normalizeDiagnosticCode(diagnostic.code),
        message: String(diagnostic.message || ""),
        updatedAt: Date.now()
      }))
      .filter((diagnostic) => diagnostic.message);

    if (cached.length) {
      this.cache.set(uri.toString(), cached);
    } else {
      this.cache.delete(uri.toString());
    }
  }

  isWorkspaceUri(uri) {
    if (!uri || uri.scheme !== "file") {
      return false;
    }

    const workspace = this.vscode && this.vscode.workspace;
    if (!workspace || typeof workspace.getWorkspaceFolder !== "function") {
      return true;
    }

    return Boolean(workspace.getWorkspaceFolder(uri));
  }
}

function isErrorOrWarning(vscode, diagnostic) {
  if (!diagnostic) {
    return false;
  }

  const severity = vscode && vscode.DiagnosticSeverity
    ? vscode.DiagnosticSeverity
    : { Error: 0, Warning: 1 };

  return diagnostic.severity === severity.Error || diagnostic.severity === severity.Warning;
}

function normalizeDiagnosticCode(code) {
  if (typeof code === "string" || typeof code === "number") {
    return code;
  }

  if (code && (typeof code.value === "string" || typeof code.value === "number")) {
    return code.value;
  }

  return undefined;
}

module.exports = {
  DiagnosticsCache,
  isErrorOrWarning
};
