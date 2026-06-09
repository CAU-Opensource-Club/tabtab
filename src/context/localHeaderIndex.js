const path = require("path");

const HEADER_GLOB = "**/*.{h,hpp,hh,hxx}";
const DEFAULT_EXCLUDE_GLOBS = Object.freeze([
  "**/build/**",
  "**/cmake-build-*/**",
  "**/.git/**",
  "**/node_modules/**",
  "**/third_party/**",
  "**/external/**",
  "**/vendor/**"
]);

class LocalHeaderIndex {
  constructor({ vscode, output } = {}) {
    this.vscode = vscode;
    this.output = output;
    this.fileSymbols = new Map();
    this.symbolIndex = new Map();
    this.disposables = [];
    this.pendingFileRefreshes = new Map();
    this.ready = false;
    this.refreshing = false;
    this.initialized = false;
  }

  async initialize(context) {
    if (this.initialized || !this.isEnabled()) {
      return;
    }

    const workspace = this.vscode && this.vscode.workspace;
    if (!workspace) {
      return;
    }

    this.initialized = true;

    if (typeof workspace.createFileSystemWatcher === "function") {
      const watcher = workspace.createFileSystemWatcher(HEADER_GLOB);
      watcher.onDidCreate((uri) => this.scheduleRefreshFile(uri));
      watcher.onDidChange((uri) => this.scheduleRefreshFile(uri));
      watcher.onDidDelete((uri) => this.removeFile(uri));
      this.disposables.push(watcher);
    }

    if (context && Array.isArray(context.subscriptions)) {
      context.subscriptions.push(this);
    }

    await this.refreshAll("initialize");
  }

  dispose() {
    for (const timer of this.pendingFileRefreshes.values()) {
      clearTimeout(timer);
    }
    this.pendingFileRefreshes.clear();

    for (const disposable of this.disposables.splice(0)) {
      if (disposable && typeof disposable.dispose === "function") {
        disposable.dispose();
      }
    }

    this.fileSymbols.clear();
    this.symbolIndex.clear();
    this.ready = false;
    this.initialized = false;
  }

  async refreshAll(reason) {
    if (!this.isEnabled() || this.refreshing) {
      return;
    }

    const workspace = this.vscode && this.vscode.workspace;
    if (!workspace || typeof workspace.findFiles !== "function") {
      return;
    }

    this.refreshing = true;
    try {
      const exclude = buildExcludeGlob(this.getExcludeGlobs());
      const uris = await workspace.findFiles(HEADER_GLOB, exclude, 2000);
      for (const uri of uris || []) {
        try {
          await this.refreshFile(uri);
        } catch (error) {
          this.log(`Local header index skipped ${uri.toString()}: ${error.message || String(error)}`);
        }
      }
      this.ready = true;
    } catch (error) {
      this.log(`Local header index refresh failed${reason ? ` (${reason})` : ""}: ${error.message || String(error)}`);
    } finally {
      this.refreshing = false;
    }
  }

  async refreshFile(uri) {
    if (!uri || !this.isEnabled() || this.isExcluded(uri)) {
      return;
    }

    const symbols = await this.extractSymbols(uri);
    this.setFileSymbols(uri, symbols);
    this.ready = true;
  }

  removeFile(uri) {
    if (!uri) {
      return;
    }

    const key = uri.toString();
    this.fileSymbols.delete(key);
    this.rebuildSymbolIndex();
  }

  lookupSymbol(name) {
    if (!name) {
      return [];
    }

    return [...(this.symbolIndex.get(name) || [])];
  }

  scheduleRefreshFile(uri) {
    if (!uri) {
      return;
    }

    const key = uri.toString();
    const existing = this.pendingFileRefreshes.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    this.pendingFileRefreshes.set(key, setTimeout(() => {
      this.pendingFileRefreshes.delete(key);
      this.refreshFile(uri).catch((error) => {
        this.log(`Local header index file refresh failed: ${error.message || String(error)}`);
      });
    }, 500));
  }

  async extractSymbols(uri) {
    const symbolProviderSymbols = await this.extractWithSymbolProvider(uri);
    if (symbolProviderSymbols.length) {
      return symbolProviderSymbols;
    }

    return this.extractWithRegex(uri);
  }

  async extractWithSymbolProvider(uri) {
    const commands = this.vscode && this.vscode.commands;
    if (!commands || typeof commands.executeCommand !== "function") {
      return [];
    }

    try {
      const symbols = await commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
      return collectDocumentSymbols({
        vscode: this.vscode,
        symbols,
        uri,
        includeText: this.getIncludeText(uri)
      });
    } catch (error) {
      return [];
    }
  }

  async extractWithRegex(uri) {
    const text = await this.readUriText(uri);
    return extractHeaderSymbolsFromText({
      text,
      uri,
      includeText: this.getIncludeText(uri),
      vscode: this.vscode
    });
  }

  async readUriText(uri) {
    const workspace = this.vscode && this.vscode.workspace;
    if (workspace && workspace.fs && typeof workspace.fs.readFile === "function") {
      const bytes = await workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    }

    return "";
  }

  setFileSymbols(uri, symbols) {
    this.fileSymbols.set(uri.toString(), symbols || []);
    this.rebuildSymbolIndex();
  }

  rebuildSymbolIndex() {
    const next = new Map();

    for (const symbols of this.fileSymbols.values()) {
      for (const symbol of symbols) {
        const names = [symbol.name, symbol.qualifiedName].filter(Boolean);
        for (const name of names) {
          if (!next.has(name)) {
            next.set(name, []);
          }
          next.get(name).push(symbol);
        }
      }
    }

    for (const entries of next.values()) {
      entries.sort(compareHeaderSymbols);
    }

    this.symbolIndex = next;
  }

  getIncludeText(uri) {
    const workspace = this.vscode && this.vscode.workspace;
    const folder = workspace && typeof workspace.getWorkspaceFolder === "function"
      ? workspace.getWorkspaceFolder(uri)
      : undefined;
    const root = folder && folder.uri && folder.uri.fsPath ? folder.uri.fsPath : "";
    const fsPath = uri && uri.fsPath ? uri.fsPath : "";
    let relativePath = root && fsPath ? path.relative(root, fsPath) : fsPath;

    relativePath = normalizePath(relativePath);
    if (relativePath.startsWith("include/")) {
      return relativePath.slice("include/".length);
    }

    return relativePath;
  }

  getExcludeGlobs() {
    const workspace = this.vscode && this.vscode.workspace;
    const config = workspace && typeof workspace.getConfiguration === "function"
      ? workspace.getConfiguration("tabtab")
      : undefined;
    const value = config && typeof config.get === "function"
      ? config.get("localHeaderIndex.excludeGlobs")
      : undefined;

    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : [...DEFAULT_EXCLUDE_GLOBS];
  }

  isEnabled() {
    const workspace = this.vscode && this.vscode.workspace;
    const config = workspace && typeof workspace.getConfiguration === "function"
      ? workspace.getConfiguration("tabtab")
      : undefined;
    const value = config && typeof config.get === "function"
      ? config.get("localHeaderIndex.enabled")
      : undefined;

    return typeof value === "boolean" ? value : true;
  }

  isExcluded(uri) {
    const includeText = this.getIncludeText(uri);
    return this.getExcludeGlobs().some((glob) => matchesSimpleExclude(includeText, glob));
  }

  log(message) {
    if (this.output && typeof this.output.appendLine === "function") {
      this.output.appendLine(message);
    }
  }
}

function collectDocumentSymbols({ vscode, symbols, uri, includeText }) {
  if (!Array.isArray(symbols)) {
    return [];
  }

  const result = [];
  const kinds = vscode && vscode.SymbolKind ? vscode.SymbolKind : {};

  const visit = (symbol, namespaces) => {
    if (!symbol) {
      return;
    }

    const kind = symbol.kind;
    const name = typeof symbol.name === "string" ? symbol.name.trim() : "";
    const children = Array.isArray(symbol.children) ? symbol.children : [];

    if (!name) {
      return;
    }

    if (kind === kinds.Namespace || kind === "Namespace") {
      for (const child of children) {
        visit(child, [...namespaces, name]);
      }
      return;
    }

    if (isIndexableSymbolKind(kind, kinds)) {
      result.push({
        name,
        qualifiedName: namespaces.length ? `${namespaces.join("::")}::${name}` : name,
        kind,
        headerUri: uri,
        includeText,
        line: symbol.range && symbol.range.start ? symbol.range.start.line + 1 : 1,
        confidence: "high"
      });
    }
  };

  for (const symbol of symbols) {
    visit(symbol, []);
  }

  return result;
}

function extractHeaderSymbolsFromText({ text, uri, includeText, vscode }) {
  const result = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const namespaces = [];
  let braceDepth = 0;
  const kinds = vscode && vscode.SymbolKind ? vscode.SymbolKind : {};

  for (let index = 0; index < lines.length; index += 1) {
    while (namespaces.length && braceDepth < namespaces[namespaces.length - 1].bodyDepth) {
      namespaces.pop();
    }

    const line = stripLineComment(lines[index]);
    const namespaceMatch = line.match(/^\s*namespace\s+([A-Za-z_]\w*)\s*\{/);
    if (namespaceMatch) {
      const bodyDepth = braceDepth + countChar(line, "{") - countChar(line, "}");
      namespaces.push({ name: namespaceMatch[1], bodyDepth: Math.max(bodyDepth, braceDepth + 1) });
      braceDepth += countChar(line, "{") - countChar(line, "}");
      continue;
    }

    const topLevel = namespaces.length
      ? braceDepth === namespaces[namespaces.length - 1].bodyDepth
      : braceDepth === 0;
    if (topLevel) {
      const symbol = matchHeaderSymbol(line, {
        uri,
        includeText,
        line: index + 1,
        namespaces: namespaces.map((entry) => entry.name),
        kinds
      });
      if (symbol) {
        result.push(symbol);
      }
    }

    braceDepth += countChar(line, "{") - countChar(line, "}");
  }

  return result;
}

function matchHeaderSymbol(line, context) {
  const text = String(line || "");
  let match = text.match(/^\s*(?:template\s*<[^>]+>\s*)?(class|struct)\s+([A-Za-z_]\w*)\b/);
  if (match) {
    return makeHeaderSymbol({
      name: match[2],
      kind: match[1] === "class" ? context.kinds.Class : context.kinds.Struct,
      confidence: "medium",
      ...context
    });
  }

  match = text.match(/^\s*enum\s+(?:class\s+)?([A-Za-z_]\w*)\b/);
  if (match) {
    return makeHeaderSymbol({
      name: match[1],
      kind: context.kinds.Enum,
      confidence: "medium",
      ...context
    });
  }

  match = text.match(/^\s*using\s+([A-Za-z_]\w*)\s*=/);
  if (match) {
    return makeHeaderSymbol({
      name: match[1],
      kind: context.kinds.TypeAlias || "TypeAlias",
      confidence: "medium",
      ...context
    });
  }

  match = text.match(/^\s*typedef\b.*\b([A-Za-z_]\w*)\s*;/);
  if (match) {
    return makeHeaderSymbol({
      name: match[1],
      kind: context.kinds.TypeAlias || "TypeAlias",
      confidence: "low",
      ...context
    });
  }

  return undefined;
}

function makeHeaderSymbol({ name, namespaces, kind, uri, includeText, line, confidence }) {
  return {
    name,
    qualifiedName: namespaces.length ? `${namespaces.join("::")}::${name}` : name,
    kind,
    headerUri: uri,
    includeText,
    line,
    confidence
  };
}

function isIndexableSymbolKind(kind, kinds) {
  return kind === kinds.Class
    || kind === kinds.Struct
    || kind === kinds.Enum
    || kind === kinds.TypeAlias
    || kind === "Class"
    || kind === "Struct"
    || kind === "Enum"
    || kind === "TypeAlias";
}

function compareHeaderSymbols(a, b) {
  const confidence = confidenceScore(b.confidence) - confidenceScore(a.confidence);
  if (confidence !== 0) {
    return confidence;
  }

  const publicHeader = publicHeaderScore(b) - publicHeaderScore(a);
  if (publicHeader !== 0) {
    return publicHeader;
  }

  return String(a.includeText || "").localeCompare(String(b.includeText || ""));
}

function publicHeaderScore(symbol) {
  const includeText = symbol && symbol.includeText ? symbol.includeText : "";
  if (!includeText) {
    return 0;
  }

  if (!includeText.startsWith("src/")) {
    return 2;
  }

  return 1;
}

function confidenceScore(value) {
  return value === "high" ? 3 : value === "medium" ? 2 : value === "low" ? 1 : 0;
}

function buildExcludeGlob(globs) {
  return `{${(globs && globs.length ? globs : DEFAULT_EXCLUDE_GLOBS).join(",")}}`;
}

function matchesSimpleExclude(file, glob) {
  const normalizedFile = normalizePath(file);
  const normalizedGlob = normalizePath(glob);
  const match = normalizedGlob.match(/^\*\*\/(.+)\/\*\*$/);
  if (!match) {
    return false;
  }

  const directoryPattern = escapeRegExp(match[1]).replace(/\\\*/g, "[^/]*");
  return new RegExp(`(^|/)${directoryPattern}(/|$)`).test(normalizedFile);
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function stripLineComment(line) {
  return String(line || "").replace(/\/\/.*$/, "");
}

function countChar(text, char) {
  let count = 0;
  for (const value of String(text || "")) {
    if (value === char) {
      count += 1;
    }
  }
  return count;
}

module.exports = {
  LocalHeaderIndex,
  DEFAULT_EXCLUDE_GLOBS,
  extractHeaderSymbolsFromText
};
