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
    this.headerFiles = new Map();
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
    this.headerFiles.clear();
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

    const includeText = this.getIncludeText(uri);
    this.headerFiles.set(uri.toString(), {
      headerUri: uri,
      includeText
    });

    const symbols = await this.extractSymbols(uri, includeText);
    this.setFileSymbols(uri, symbols);
    this.ready = true;
  }

  removeFile(uri) {
    if (!uri) {
      return;
    }

    const key = uri.toString();
    const previous = this.fileSymbols.get(key) || [];
    this.fileSymbols.delete(key);
    this.headerFiles.delete(key);
    this.removeSymbolsFromIndex(previous);
  }

  lookupSymbol(name) {
    if (!name) {
      return [];
    }

    return [...(this.symbolIndex.get(name) || [])];
  }

  lookupIncludePrefix(prefix) {
    const normalized = normalizeIncludePrefix(prefix);
    if (!normalized) {
      return [];
    }

    return [...this.headerFiles.values()]
      .map((entry) => ({
        ...entry,
        score: includePrefixScore(entry.includeText, normalized)
      }))
      .filter((entry) => entry.score > 0)
      .sort(compareIncludePrefixMatches)
      .map(({ score, ...entry }) => entry);
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

  async extractSymbols(uri, includeText = this.getIncludeText(uri)) {
    const symbolProviderSymbols = await this.extractWithSymbolProvider(uri, includeText);
    if (symbolProviderSymbols.length) {
      return symbolProviderSymbols;
    }

    return this.extractWithRegex(uri, includeText);
  }

  async extractWithSymbolProvider(uri, includeText = this.getIncludeText(uri)) {
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
        includeText
      });
    } catch (error) {
      return [];
    }
  }

  async extractWithRegex(uri, includeText = this.getIncludeText(uri)) {
    const text = await this.readUriText(uri);
    return extractHeaderSymbolsFromText({
      text,
      uri,
      includeText,
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
    const key = uri.toString();
    const previous = this.fileSymbols.get(key) || [];
    const next = symbols || [];

    this.removeSymbolsFromIndex(previous);
    this.fileSymbols.set(key, next);
    this.addSymbolsToIndex(next);
  }

  addSymbolsToIndex(symbols) {
    const affectedNames = new Set();

    for (const symbol of symbols) {
      for (const name of getSymbolIndexNames(symbol)) {
        if (!this.symbolIndex.has(name)) {
          this.symbolIndex.set(name, []);
        }
        this.symbolIndex.get(name).push(symbol);
        affectedNames.add(name);
      }
    }

    for (const name of affectedNames) {
      this.symbolIndex.get(name).sort(compareHeaderSymbols);
    }
  }

  removeSymbolsFromIndex(symbols) {
    if (!symbols || !symbols.length) {
      return;
    }

    const removed = new Set(symbols);
    for (const symbol of symbols) {
      for (const name of getSymbolIndexNames(symbol)) {
        const entries = this.symbolIndex.get(name);
        if (!entries) {
          continue;
        }

        const remaining = entries.filter((entry) => !removed.has(entry));
        if (remaining.length) {
          this.symbolIndex.set(name, remaining);
        } else {
          this.symbolIndex.delete(name);
        }
      }
    }
  }

  rebuildSymbolIndex() {
    const next = new Map();

    for (const symbols of this.fileSymbols.values()) {
      for (const symbol of symbols) {
        for (const name of getSymbolIndexNames(symbol)) {
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

function getSymbolIndexNames(symbol) {
  const name = symbol && symbol.name;
  const qualifiedName = symbol && symbol.qualifiedName;

  if (!name) {
    return qualifiedName ? [qualifiedName] : [];
  }

  return qualifiedName && qualifiedName !== name
    ? [name, qualifiedName]
    : [name];
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

function includePrefixScore(includeText, normalizedPrefix) {
  const normalizedInclude = normalizePath(includeText).toLowerCase();
  const basename = path.basename(normalizedInclude);

  if (normalizedInclude.startsWith(normalizedPrefix)) {
    return 3;
  }

  if (basename.startsWith(normalizedPrefix)) {
    return 2;
  }

  return 0;
}

function compareIncludePrefixMatches(a, b) {
  const score = (b.score || 0) - (a.score || 0);
  if (score !== 0) {
    return score;
  }

  return String(a.includeText || "").localeCompare(String(b.includeText || ""));
}

function normalizeIncludePrefix(value) {
  return normalizePath(value)
    .replace(/^["']|["']$/g, "")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
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
