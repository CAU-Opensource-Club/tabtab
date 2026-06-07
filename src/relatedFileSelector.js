const path = require("path");

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "build",
  "dist",
  "node_modules",
  "vendor",
  "out",
  "target",
  ".next",
  ".nuxt",
  "coverage"
]);

const LOCK_FILE_PATTERN = /(^|[\\/])(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|Gemfile\.lock|Pipfile\.lock|poetry\.lock|composer\.lock|go\.sum|.*\.lock)$/i;
const SENSITIVE_FILE_PATTERN = /(^|[\\/])(\.env($|[.\-_])|.*secret.*|.*credential.*|.*token.*|\.npmrc|\.pypirc|id_rsa|id_ed25519|tabtab\.config\.json)$/i;
const GENERATED_FILE_PATTERN = /(\.min\.(js|css)$|\.generated\.|\.g\.(c|cc|cpp|cxx|h|hpp|hh|cs|go|java)$|[\\/]generated[\\/]|[\\/]gen[\\/])/i;
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".cs", ".go", ".java", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rs", ".rb", ".php", ".swift", ".kt", ".kts", ".scala",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".css",
  ".scss", ".less", ".sql", ".sh", ".ps1", ".md"
]);
const CPP_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]);
const CPP_PAIR_EXTENSIONS = [".h", ".hh", ".hpp", ".hxx", ".c", ".cc", ".cpp", ".cxx"];

class RelatedFileSelector {
  constructor({ vscode, context, output }) {
    this.vscode = vscode;
    this.output = output;
    this.recentUris = [];

    if (context && context.subscriptions) {
      context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
          this.recordDocument(event.document);
        })
      );
    }
  }

  recordDocument(document) {
    if (!document || !document.uri || this.isExcludedUri(document.uri)) {
      return;
    }

    const key = document.uri.toString();
    this.recentUris = [key, ...this.recentUris.filter((uri) => uri !== key)].slice(0, 40);
  }

  async select({ document, position, token, config }) {
    if (token && token.isCancellationRequested) {
      return [];
    }

    const activeWords = getActiveWords(document, position);
    const candidates = [];

    this.addOpenDocumentCandidates(candidates, document, activeWords, config);
    await this.addPairFileCandidates(candidates, document, activeWords, config, token);
    await this.addLspCandidates(candidates, document, position, activeWords, config, token);
    await this.addRecentCandidates(candidates, document, activeWords, config, token);

    return dedupeChunks(candidates)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, config.maxRelatedFiles);
  }

  addOpenDocumentCandidates(candidates, currentDocument, activeWords, config) {
    for (const doc of this.vscode.workspace.textDocuments) {
      if (!doc || doc.uri.toString() === currentDocument.uri.toString()) {
        continue;
      }

      if (this.isExcludedDocument(doc, config) || !this.isRelatedDocument(doc, currentDocument, activeWords)) {
        continue;
      }

      const snippet = this.extractRelevantSnippet(doc.getText(), activeWords, undefined, config);
      if (snippet) {
        candidates.push({
          label: `open file: ${getDisplayPath(doc.uri)}`,
          text: snippet,
          score: this.scoreDocument(doc, currentDocument, activeWords) + 30
        });
      }
    }
  }

  async addPairFileCandidates(candidates, currentDocument, activeWords, config, token) {
    const currentPath = currentDocument.uri && currentDocument.uri.fsPath;
    const ext = currentPath ? path.extname(currentPath).toLowerCase() : "";

    if (!currentPath || !CPP_EXTENSIONS.has(ext) || !this.vscode.workspace.workspaceFolders) {
      return;
    }

    const workspaceFolder = this.vscode.workspace.getWorkspaceFolder(currentDocument.uri);
    if (!workspaceFolder) {
      return;
    }

    const parsed = path.parse(currentPath);
    const pattern = `**/${escapeGlob(parsed.name)}.*`;
    const exclude = "{**/.git/**,**/node_modules/**,**/vendor/**,**/build/**,**/dist/**,**/out/**,**/target/**}";
    let uris = [];

    try {
      uris = await this.vscode.workspace.findFiles(
        new this.vscode.RelativePattern(workspaceFolder, pattern),
        exclude,
        24
      );
    } catch (error) {
      this.log(`Pair file search failed: ${error.message || String(error)}`);
      return;
    }

    for (const uri of uris) {
      if (token && token.isCancellationRequested) {
        return;
      }

      if (uri.toString() === currentDocument.uri.toString()) {
        continue;
      }

      const candidateExt = path.extname(uri.fsPath || "").toLowerCase();
      if (!CPP_PAIR_EXTENSIONS.includes(candidateExt) || this.isExcludedUri(uri)) {
        continue;
      }

      const text = await this.readFileText(uri, config);
      const snippet = this.extractRelevantSnippet(text, activeWords, undefined, config);
      if (snippet) {
        candidates.push({
          label: `C++ pair: ${getDisplayPath(uri)}`,
          text: snippet,
          score: 95
        });
      }
    }
  }

  async addLspCandidates(candidates, document, position, activeWords, config, token) {
    const definitionLocations = await this.executeLsp("vscode.executeDefinitionProvider", document.uri, position, config);
    const declarationLocations = await this.executeLsp("vscode.executeDeclarationProvider", document.uri, position, config);
    const locations = [
      ...normalizeLocations(definitionLocations),
      ...normalizeLocations(declarationLocations)
    ];

    for (const location of locations.slice(0, 8)) {
      if (token && token.isCancellationRequested) {
        return;
      }

      const uri = location.uri;
      const range = location.range;
      if (!uri || this.isExcludedUri(uri)) {
        continue;
      }

      const text = uri.toString() === document.uri.toString()
        ? document.getText()
        : await this.readFileText(uri, config);
      const snippet = this.extractRelevantSnippet(text, activeWords, range, config);

      if (snippet) {
        candidates.push({
          label: `LSP context: ${getDisplayPath(uri)}`,
          text: snippet,
          score: uri.toString() === document.uri.toString() ? 80 : 90
        });
      }
    }
  }

  async addRecentCandidates(candidates, currentDocument, activeWords, config, token) {
    for (const key of this.recentUris.slice(0, 12)) {
      if (token && token.isCancellationRequested) {
        return;
      }

      let uri;
      try {
        uri = this.vscode.Uri.parse(key);
      } catch (error) {
        continue;
      }

      if (!uri || uri.toString() === currentDocument.uri.toString() || this.isExcludedUri(uri)) {
        continue;
      }

      const openDocument = this.vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
      const text = openDocument ? openDocument.getText() : await this.readFileText(uri, config);
      const snippet = this.extractRelevantSnippet(text, activeWords, undefined, config);

      if (snippet) {
        candidates.push({
          label: `recent edit: ${getDisplayPath(uri)}`,
          text: snippet,
          score: openDocument ? 72 : 64
        });
      }
    }
  }

  async executeLsp(command, uri, position, config) {
    try {
      return await withTimeout(
        this.vscode.commands.executeCommand(command, uri, position),
        config.lspTimeoutMs
      );
    } catch (error) {
      return [];
    }
  }

  async readFileText(uri, config) {
    if (!uri || uri.scheme !== "file" || this.isExcludedUri(uri)) {
      return "";
    }

    try {
      const stat = await this.vscode.workspace.fs.stat(uri);
      if (stat.size > config.maxRelatedFileBytes || this.isExcludedUri(uri, stat)) {
        return "";
      }

      const bytes = await this.vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      return looksGenerated(text) ? "" : text;
    } catch (error) {
      return "";
    }
  }

  isExcludedDocument(document, config) {
    if (!document || !document.uri || this.isExcludedUri(document.uri)) {
      return true;
    }

    const textLength = document.getText().length;
    return textLength > config.maxRelatedFileBytes || looksGenerated(document.getText().slice(0, 4096));
  }

  isExcludedUri(uri, stat) {
    if (!uri || (uri.scheme !== "file" && uri.scheme !== "untitled")) {
      return true;
    }

    if (uri.scheme === "untitled") {
      return false;
    }

    const fsPath = String(uri.fsPath || "");
    const normalized = fsPath.toLowerCase();
    const segments = normalized.split(/[\\/]+/);
    const ext = path.extname(normalized);

    if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
      return true;
    }

    if (LOCK_FILE_PATTERN.test(normalized) || SENSITIVE_FILE_PATTERN.test(normalized) || GENERATED_FILE_PATTERN.test(normalized)) {
      return true;
    }

    if (stat && stat.size > 1024 * 1024) {
      return true;
    }

    return Boolean(ext) && !TEXT_EXTENSIONS.has(ext);
  }

  isRelatedDocument(document, currentDocument, activeWords) {
    if (!document || !currentDocument) {
      return false;
    }

    if (document.languageId === currentDocument.languageId) {
      return true;
    }

    const docPath = document.uri.fsPath || "";
    const currentPath = currentDocument.uri.fsPath || "";
    if (docPath && currentPath && path.dirname(docPath) === path.dirname(currentPath)) {
      return true;
    }

    const text = document.getText().slice(0, 12000);
    return activeWords.some((word) => word.length >= 4 && text.includes(word));
  }

  scoreDocument(document, currentDocument, activeWords) {
    let score = 10;

    if (document.languageId === currentDocument.languageId) {
      score += 25;
    }

    if (document.uri.scheme === "file" && currentDocument.uri.scheme === "file") {
      const docPath = document.uri.fsPath || "";
      const currentPath = currentDocument.uri.fsPath || "";
      if (path.dirname(docPath) === path.dirname(currentPath)) {
        score += 20;
      }

      if (path.parse(docPath).name === path.parse(currentPath).name) {
        score += 35;
      }
    }

    const text = document.getText().slice(0, 16000);
    for (const word of activeWords) {
      if (word.length >= 4 && text.includes(word)) {
        score += 5;
      }
    }

    return score;
  }

  extractRelevantSnippet(text, activeWords, range, config) {
    if (!text || text.length > config.maxRelatedFileBytes || looksGenerated(text.slice(0, 4096))) {
      return "";
    }

    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const sections = [];
    const imports = collectTopImports(lines);

    if (imports) {
      sections.push(imports);
    }

    if (range && Number.isInteger(range.start.line)) {
      sections.push(sliceLines(lines, Math.max(0, range.start.line - 6), Math.min(lines.length, range.end.line + 7)));
    }

    for (const word of activeWords.filter((value) => value.length >= 4).slice(0, 5)) {
      const lineIndex = lines.findIndex((line) => line.includes(word));
      if (lineIndex >= 0) {
        sections.push(sliceLines(lines, Math.max(0, lineIndex - 4), Math.min(lines.length, lineIndex + 5)));
      }
    }

    if (sections.length <= 1) {
      const signatures = collectSymbolLines(lines, 24);
      if (signatures) {
        sections.push(signatures);
      }
    }

    return uniqueSections(sections)
      .join("\n// ---\n")
      .slice(0, Math.floor(config.maxRelatedFileBytes / 4))
      .trim();
  }

  log(message) {
    if (this.output && typeof this.output.appendLine === "function") {
      this.output.appendLine(message);
    }
  }
}

function getActiveWords(document, position) {
  const words = new Set();
  const line = document.lineAt(position.line).text;
  const beforeCursor = line.slice(0, position.character);
  const aroundCursor = line;
  const currentWord = beforeCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const identifiers = aroundCursor.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];

  if (currentWord) {
    words.add(currentWord[0]);
  }

  for (const identifier of identifiers.slice(-8)) {
    words.add(identifier);
  }

  if (document.uri && document.uri.fsPath) {
    const parsed = path.parse(document.uri.fsPath);
    if (parsed.name) {
      for (const part of parsed.name.split(/[^A-Za-z0-9_]+/)) {
        if (part.length >= 3) {
          words.add(part);
        }
      }
    }
  }

  return [...words];
}

function collectTopImports(lines) {
  const imports = [];
  const importPattern = /^\s*(#\s*(include|import)|import\s|from\s+\S+\s+import\s|using\s+|package\s+|const\s+\w+\s*=\s*require\(|var\s+\w+\s*=\s*require\(|let\s+\w+\s*=\s*require\()/;

  for (const line of lines.slice(0, 220)) {
    if (importPattern.test(line) || /^\s*#\s*pragma\s+once\b/.test(line)) {
      imports.push(line);
    }
  }

  return imports.join("\n").trim();
}

function collectSymbolLines(lines, maxLines) {
  const symbols = [];

  for (const line of lines) {
    if (isSymbolLikeLine(line)) {
      symbols.push(line);
      if (symbols.length >= maxLines) {
        break;
      }
    }
  }

  return symbols.join("\n").trim();
}

function isSymbolLikeLine(line) {
  const text = line.trim();
  if (!text || text.length > 220) {
    return false;
  }

  return /^(export\s+)?(async\s+)?function\s+/.test(text)
    || /^(export\s+)?(class|struct|interface|enum|namespace)\s+/.test(text)
    || /^(template\s*<.*>\s*)?[\w:<>~*&\s]+\s+[A-Za-z_~][\w:]*\s*\([^;{}]*\)\s*(const\b|noexcept\b|override\b|final\b|->|;|\{)?/.test(text)
    || /^(const|let|var)\s+[A-Za-z_]\w*\s*=\s*(async\s*)?\(/.test(text);
}

function sliceLines(lines, start, end) {
  return lines.slice(start, end).join("\n").trim();
}

function uniqueSections(sections) {
  const seen = new Set();
  const unique = [];

  for (const section of sections) {
    const normalized = String(section || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function normalizeLocations(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item) {
        return undefined;
      }

      if (item.uri && item.range) {
        return item;
      }

      if (item.targetUri && item.targetRange) {
        return {
          uri: item.targetUri,
          range: item.targetRange
        };
      }

      return undefined;
    })
    .filter(Boolean);
}

function dedupeChunks(chunks) {
  const seen = new Set();
  const unique = [];

  for (const chunk of chunks) {
    const key = `${chunk.label}\n${chunk.text}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(chunk);
  }

  return unique;
}

function looksGenerated(text) {
  return /(@generated|auto-generated|automatically generated|do not edit|generated by)/i.test(text || "");
}

function getDisplayPath(uri) {
  return uri && uri.fsPath ? path.basename(uri.fsPath) : String(uri || "");
}

function escapeGlob(value) {
  return String(value).replace(/[\\{}\[\]*?]/g, (match) => `[${match}]`);
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve([]), timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

module.exports = {
  RelatedFileSelector
};
