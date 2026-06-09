const STANDARD_SYMBOL_HEADERS = Object.freeze({
  "std::vector": "<vector>",
  "std::array": "<array>",
  "std::string": "<string>",
  "std::string_view": "<string_view>",
  "std::optional": "<optional>",
  "std::variant": "<variant>",
  "std::span": "<span>",
  "std::tuple": "<tuple>",
  "std::pair": "<utility>",
  "std::move": "<utility>",
  "std::forward": "<utility>",
  "std::unique_ptr": "<memory>",
  "std::shared_ptr": "<memory>",
  "std::make_unique": "<memory>",
  "std::make_shared": "<memory>",
  "std::unordered_map": "<unordered_map>",
  "std::unordered_set": "<unordered_set>",
  "std::map": "<map>",
  "std::set": "<set>",
  "std::queue": "<queue>",
  "std::stack": "<stack>",
  "std::deque": "<deque>",
  "std::list": "<list>",
  "std::function": "<functional>",
  "std::atomic": "<atomic>",
  "std::mutex": "<mutex>",
  "std::lock_guard": "<mutex>",
  "std::unique_lock": "<mutex>",
  "std::thread": "<thread>",
  "std::jthread": "<thread>",
  "std::condition_variable": "<condition_variable>",
  "std::chrono": "<chrono>",
  "std::filesystem": "<filesystem>",
  "std::cout": "<iostream>",
  "std::cerr": "<iostream>",
  "std::cin": "<iostream>",
  "std::ostream": "<ostream>",
  "std::istream": "<istream>",
  "std::sort": "<algorithm>",
  "std::find": "<algorithm>",
  "std::lower_bound": "<algorithm>",
  "std::upper_bound": "<algorithm>",
  "std::accumulate": "<numeric>",
  "std::iota": "<numeric>",
  "std::numeric_limits": "<limits>",
  "std::enable_if_t": "<type_traits>",
  "std::is_same_v": "<type_traits>",
  "std::initializer_list": "<initializer_list>",
  "std::uint8_t": "<cstdint>",
  "std::uint16_t": "<cstdint>",
  "std::uint32_t": "<cstdint>",
  "std::uint64_t": "<cstdint>",
  "uint8_t": "<cstdint>",
  "uint16_t": "<cstdint>",
  "uint32_t": "<cstdint>",
  "uint64_t": "<cstdint>",
  "std::size_t": "<cstddef>",
  "size_t": "<cstddef>",
  "std::memcpy": "<cstring>",
  "std::memset": "<cstring>",
  "std::memcmp": "<cstring>",
  "memcpy": "<cstring>",
  "memset": "<cstring>",
  "memcmp": "<cstring>",
  "assert": "<cassert>"
});

const CONFIDENCE_SCORE = {
  high: 3,
  medium: 2,
  low: 1
};

class IncludeAssist {
  constructor({ vscode } = {}) {
    this.vscode = vscode;
  }

  inferMissingStandardIncludes({ document, diagnostics, position } = {}) {
    if (!isCppDocument(document)) {
      return [];
    }

    const existing = collectExistingIncludes(document);
    const hints = [];

    for (const diagnostic of diagnostics || []) {
      const symbolHints = inferStandardSymbolsFromDiagnostic(diagnostic);
      for (const symbolHint of symbolHints) {
        const header = STANDARD_SYMBOL_HEADERS[symbolHint.symbol];
        if (!header || existing.angleIncludes.has(header)) {
          continue;
        }

        hints.push({
          header,
          symbol: symbolHint.symbol,
          line: getDiagnosticLine(diagnostic),
          source: diagnostic.source,
          message: String(diagnostic.message || ""),
          severity: diagnostic.severity,
          confidence: symbolHint.confidence
        });
      }
    }

    return sortAndDedupeHints(hints, position, (hint) => hint.header);
  }

  inferMissingProjectIncludes({ document, diagnostics, position, localHeaderIndex } = {}) {
    if (!isCppDocument(document) || !localHeaderIndex || typeof localHeaderIndex.lookupSymbol !== "function") {
      return [];
    }

    const existing = collectExistingIncludes(document);
    const candidates = [];

    for (const diagnostic of diagnostics || []) {
      for (const symbolHint of inferProjectSymbolsFromDiagnostic(diagnostic)) {
        const matches = localHeaderIndex.lookupSymbol(symbolHint.symbol) || [];
        for (const match of matches.slice(0, 8)) {
          const includeText = quoteInclude(match.includeText || "");
          if (!includeText || existing.quoteIncludes.has(normalizeQuoteInclude(includeText))) {
            continue;
          }

          candidates.push({
            includeText,
            symbol: symbolHint.symbol,
            line: getDiagnosticLine(diagnostic),
            source: diagnostic.source,
            message: String(diagnostic.message || ""),
            severity: diagnostic.severity,
            confidence: mergeConfidence(symbolHint.confidence, match.confidence),
            header: match,
            currentDocument: document
          });
        }
      }
    }

    const ranked = sortAndDedupeHints(
      candidates.sort((a, b) => compareProjectHints(a, b, position)),
      position,
      (hint) => `${hint.includeText}:${hint.symbol}`
    );

    return ranked.slice(0, 6).map((hint) => {
      const { header, currentDocument, ...publicHint } = hint;
      return publicHint;
    });
  }

  isCursorInIncludeRegion(document, position) {
    return isCursorInIncludeRegion(document, position);
  }
}

function inferStandardSymbolsFromDiagnostic(diagnostic) {
  const message = String(diagnostic && diagnostic.message || "");
  const result = [];
  let match;

  const patterns = [
    /no (?:member|template) named ['"]([^'"]+)['"] in namespace ['"]std['"]/ig,
    /['"]([^'"]+)['"] is not a member of ['"]std['"]/ig,
    /namespace\s+["']std["']\s+has no member\s+["']([^"']+)["']/ig
  ];

  for (const pattern of patterns) {
    while ((match = pattern.exec(message))) {
      result.push({ symbol: `std::${match[1]}`, confidence: "high" });
    }
  }

  const identifierPatterns = [
    /use of undeclared identifier ['"]([^'"]+)['"]/ig,
    /unknown type name ['"]([^'"]+)['"]/ig,
    /identifier\s+["']([^"']+)["']\s+is undefined/ig
  ];

  for (const pattern of identifierPatterns) {
    while ((match = pattern.exec(message))) {
      const symbol = match[1];
      if (STANDARD_SYMBOL_HEADERS[symbol]) {
        result.push({ symbol, confidence: "high" });
      } else if (STANDARD_SYMBOL_HEADERS[`std::${symbol}`]) {
        result.push({ symbol: `std::${symbol}`, confidence: "medium" });
      }
    }
  }

  for (const symbol of Object.keys(STANDARD_SYMBOL_HEADERS)) {
    if (message.includes(symbol)) {
      result.push({ symbol, confidence: "medium" });
    }
  }

  return dedupeSymbolHints(result);
}

function inferProjectSymbolsFromDiagnostic(diagnostic) {
  const message = String(diagnostic && diagnostic.message || "");
  const result = [];
  let match;
  const patterns = [
    /identifier\s+["']([A-Za-z_]\w*)["']\s+is undefined/ig,
    /unknown type name ['"]([A-Za-z_]\w*)['"]/ig,
    /use of undeclared identifier ['"]([A-Za-z_]\w*)['"]/ig,
    /['"]([A-Za-z_]\w*)['"]\s+(?:was not declared|is undefined)/ig
  ];

  for (const pattern of patterns) {
    while ((match = pattern.exec(message))) {
      const symbol = match[1];
      if (!STANDARD_SYMBOL_HEADERS[symbol] && !STANDARD_SYMBOL_HEADERS[`std::${symbol}`] && !isLikelyKeyword(symbol)) {
        result.push({ symbol, confidence: "high" });
      }
    }
  }

  return dedupeSymbolHints(result);
}

function collectExistingIncludes(document) {
  const angleIncludes = new Set();
  const quoteIncludes = new Set();
  const text = document && typeof document.getText === "function" ? document.getText() : "";
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");

  for (const line of lines.slice(0, 400)) {
    const match = line.match(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/);
    if (!match) {
      continue;
    }

    if (match[1] === "<") {
      angleIncludes.add(`<${match[2].trim()}>`);
    } else {
      quoteIncludes.add(normalizeQuoteInclude(`"${match[2].trim()}"`));
    }
  }

  return {
    angleIncludes,
    quoteIncludes
  };
}

function isCursorInIncludeRegion(document, position) {
  if (!document || !position || typeof document.getText !== "function") {
    return false;
  }

  const lines = document.getText().replace(/\r\n/g, "\n").split("\n");
  const cursorLine = Math.max(0, position.line);
  let lastIncludeLine = -1;
  let firstNonIncludeLine = lines.length;
  let inBlockComment = false;

  for (let index = 0; index < Math.min(lines.length, 180); index += 1) {
    const classification = classifyPreambleLine(lines[index], inBlockComment);
    inBlockComment = classification.inBlockComment;

    if (classification.kind === "include") {
      lastIncludeLine = index;
    }

    if (classification.kind === "body") {
      firstNonIncludeLine = index;
      break;
    }
  }

  if (lastIncludeLine >= 0 && cursorLine <= lastIncludeLine + 3) {
    return true;
  }

  if (cursorLine < firstNonIncludeLine && cursorLine < 80) {
    return true;
  }

  if (lastIncludeLine < 0 && cursorLine < 40) {
    for (let index = 0; index <= Math.min(cursorLine, lines.length - 1); index += 1) {
      if (looksLikeBodyStart(lines[index])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function classifyPreambleLine(line, inBlockComment) {
  const text = String(line || "").trim();

  if (inBlockComment) {
    return {
      kind: text.includes("*/") ? "comment" : "comment",
      inBlockComment: !text.includes("*/")
    };
  }

  if (!text || text.startsWith("//")) {
    return { kind: "comment", inBlockComment: false };
  }

  if (text.startsWith("/*")) {
    return { kind: "comment", inBlockComment: !text.includes("*/") };
  }

  if (/^#\s*include\b/.test(text)) {
    return { kind: "include", inBlockComment: false };
  }

  if (/^#\s*pragma\s+once\b/.test(text)) {
    return { kind: "pragma", inBlockComment: false };
  }

  return { kind: "body", inBlockComment: false };
}

function looksLikeBodyStart(line) {
  const text = String(line || "").trim();
  return /^(class|struct|namespace)\s+/.test(text)
    || /^(template\s*<.*>\s*)?(class|struct)\s+/.test(text)
    || /^[\w:<>~*&\s]+\s+[A-Za-z_~]\w*\s*\([^;{}]*\)\s*(const\b|noexcept\b|->[^{}]+)?\s*\{/.test(text);
}

function sortAndDedupeHints(hints, position, keyOf) {
  const seen = new Set();
  const result = [];

  for (const hint of hints.sort((a, b) => compareGenericHints(a, b, position))) {
    const key = keyOf(hint);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(hint);
  }

  return result;
}

function compareGenericHints(a, b, position) {
  const severity = compareSeverity(a.severity, b.severity);
  if (severity !== 0) {
    return severity;
  }

  const confidence = (CONFIDENCE_SCORE[b.confidence] || 0) - (CONFIDENCE_SCORE[a.confidence] || 0);
  if (confidence !== 0) {
    return confidence;
  }

  return distanceToPosition(a, position) - distanceToPosition(b, position);
}

function compareProjectHints(a, b, position) {
  const generic = compareGenericHints(a, b, position);
  if (generic !== 0) {
    return generic;
  }

  const locality = projectLocalityScore(b) - projectLocalityScore(a);
  if (locality !== 0) {
    return locality;
  }

  return String(a.includeText).localeCompare(String(b.includeText));
}

function compareSeverity(a, b) {
  return severityScore(b) - severityScore(a);
}

function severityScore(value) {
  return value === 0 ? 2 : value === 1 ? 1 : 0;
}

function distanceToPosition(hint, position) {
  if (!position || !Number.isFinite(hint.line)) {
    return 0;
  }

  return Math.abs((hint.line - 1) - position.line);
}

function projectLocalityScore(hint) {
  const currentPath = hint.currentDocument && hint.currentDocument.uri && hint.currentDocument.uri.fsPath
    ? normalizePath(hint.currentDocument.uri.fsPath)
    : "";
  const headerPath = hint.header && hint.header.headerUri && hint.header.headerUri.fsPath
    ? normalizePath(hint.header.headerUri.fsPath)
    : "";
  const includeText = hint.includeText || "";
  let score = 0;

  if (currentPath && headerPath && dirname(currentPath) === dirname(headerPath)) {
    score += 3;
  }
  if (/^"include\//.test(includeText) || (hint.header && /^include\//.test(hint.header.includeText || ""))) {
    score += 2;
  }
  if (/^"src\//.test(includeText) || (hint.header && /^src\//.test(hint.header.includeText || ""))) {
    score += 1;
  }

  return score;
}

function quoteInclude(value) {
  const normalized = normalizeQuoteInclude(value);
  return normalized ? `"${normalized}"` : "";
}

function normalizeQuoteInclude(value) {
  return String(value || "")
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function dirname(value) {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function mergeConfidence(a, b) {
  const left = CONFIDENCE_SCORE[a] || 0;
  const right = CONFIDENCE_SCORE[b] || 0;
  if (!left) {
    return b || "low";
  }
  if (!right) {
    return a || "low";
  }
  return left <= right ? a : b;
}

function dedupeSymbolHints(hints) {
  const bySymbol = new Map();
  for (const hint of hints) {
    const current = bySymbol.get(hint.symbol);
    if (!current || CONFIDENCE_SCORE[hint.confidence] > CONFIDENCE_SCORE[current.confidence]) {
      bySymbol.set(hint.symbol, hint);
    }
  }
  return [...bySymbol.values()];
}

function getDiagnosticLine(diagnostic) {
  return diagnostic && diagnostic.range && diagnostic.range.start
    ? diagnostic.range.start.line + 1
    : 1;
}

function isCppDocument(document) {
  const languageId = document && typeof document.languageId === "string"
    ? document.languageId.toLowerCase()
    : "";
  if (languageId) {
    return [
      "c",
      "cpp",
      "c++",
      "objective-c",
      "objective-cpp",
      "cuda-cpp"
    ].includes(languageId);
  }

  const fsPath = document && document.uri && document.uri.fsPath
    ? document.uri.fsPath.toLowerCase()
    : "";
  return /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(fsPath);
}

function isLikelyKeyword(symbol) {
  return [
    "auto",
    "bool",
    "class",
    "const",
    "double",
    "enum",
    "float",
    "int",
    "long",
    "namespace",
    "short",
    "signed",
    "struct",
    "template",
    "typename",
    "unsigned",
    "void"
  ].includes(symbol);
}

module.exports = {
  IncludeAssist,
  STANDARD_SYMBOL_HEADERS,
  collectExistingIncludes,
  inferProjectSymbolsFromDiagnostic,
  inferStandardSymbolsFromDiagnostic,
  isCursorInIncludeRegion,
  isCppDocument
};
