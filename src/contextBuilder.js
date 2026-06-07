const path = require("path");
const { TokenBudgeter } = require("./tokenBudgeter");

class ContextBuilder {
  constructor({ relatedFileSelector }) {
    this.relatedFileSelector = relatedFileSelector;
  }

  async build({ document, position, token, config }) {
    const budgeter = new TokenBudgeter({ maxPromptTokens: config.maxPromptTokens });
    const text = normalizeText(document.getText());
    const cursorOffset = document.offsetAt(position);
    const lines = text.split("\n");
    const cursorLine = lines[position.line] || "";
    const prefixParts = {
      imports: collectTopImports(lines),
      scope: collectCurrentScope(lines, position.line),
      adjacent: collectAdjacentSymbols(lines, position.line),
      local: text.slice(0, cursorOffset)
    };
    const suffixParts = {
      currentLine: cursorLine.slice(position.character),
      blockTail: collectSuffixBlock(text, cursorOffset),
      nextSignatures: collectNextSignatures(lines, position.line)
    };
    const relatedChunks = this.relatedFileSelector
      ? await this.relatedFileSelector.select({ document, position, token, config })
      : [];
    const prefix = budgeter.fitPrefixParts(prefixParts);
    const suffix = budgeter.fitSuffixParts(suffixParts);
    const extraContext = budgeter.fitExtraChunks(relatedChunks);

    return {
      prefix,
      suffix,
      extraContext,
      metadata: {
        languageId: document.languageId,
        fileName: getFileName(document),
        line: position.line + 1,
        character: position.character + 1,
        linePrefix: cursorLine.slice(0, position.character),
        lineSuffix: cursorLine.slice(position.character),
        indentation: getIndentation(cursorLine),
        promptTokens: {
          prefix: budgeter.estimateTokens(prefix),
          suffix: budgeter.estimateTokens(suffix),
          extra: budgeter.estimateTokens(extraContext)
        }
      }
    };
  }
}

function collectTopImports(lines) {
  const imports = [];
  const importPattern = /^\s*(#\s*(include|import)|import\s|from\s+\S+\s+import\s|using\s+|package\s+|const\s+\w+\s*=\s*require\(|var\s+\w+\s*=\s*require\(|let\s+\w+\s*=\s*require\()/;

  for (const line of lines.slice(0, 260)) {
    if (importPattern.test(line) || /^\s*#\s*pragma\s+once\b/.test(line)) {
      imports.push(line);
    }
  }

  return imports.join("\n").trim();
}

function collectCurrentScope(lines, cursorLine) {
  const stack = [];

  for (let index = 0; index <= cursorLine; index += 1) {
    const line = stripLineComment(lines[index] || "");
    const opens = countChar(line, "{");
    const closes = countChar(line, "}");

    for (let closeIndex = 0; closeIndex < closes; closeIndex += 1) {
      stack.pop();
    }

    for (let openIndex = 0; openIndex < opens; openIndex += 1) {
      stack.push({
        line: index,
        text: lines[index] || ""
      });
    }
  }

  const scopeLines = stack
    .map((entry) => findScopeHeader(lines, entry.line))
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);

  return scopeLines.slice(-8).join("\n").trim();
}

function findScopeHeader(lines, lineIndex) {
  const collected = [];

  for (let index = lineIndex; index >= Math.max(0, lineIndex - 8); index -= 1) {
    const line = lines[index] || "";
    collected.unshift(line);

    if (isScopeHeaderLine(line)) {
      break;
    }
  }

  const header = collected.join("\n").trim();
  return header.length <= 1200 ? header : collected.slice(-3).join("\n").trim();
}

function isScopeHeaderLine(line) {
  const text = line.trim();
  return /^(export\s+)?(class|struct|interface|enum|namespace)\s+/.test(text)
    || /^(template\s*<.*>\s*)?[\w:<>~*&\s]+\s+[A-Za-z_~][\w:]*\s*\([^;{}]*\)\s*(const\b|noexcept\b|override\b|final\b|->|\{)?/.test(text)
    || /^(export\s+)?(async\s+)?function\s+/.test(text)
    || /^(const|let|var)\s+[A-Za-z_]\w*\s*=\s*(async\s*)?\([^)]*\)\s*=>/.test(text);
}

function collectAdjacentSymbols(lines, cursorLine) {
  const symbols = [];
  const start = Math.max(0, cursorLine - 220);
  const end = Math.min(lines.length, cursorLine + 80);

  for (let index = start; index < end; index += 1) {
    if (Math.abs(index - cursorLine) < 4) {
      continue;
    }

    const line = lines[index] || "";
    if (isSymbolLikeLine(line)) {
      symbols.push(line);
    }
  }

  return symbols.slice(-18).join("\n").trim();
}

function collectSuffixBlock(text, cursorOffset) {
  const after = text.slice(cursorOffset);
  if (!after) {
    return "";
  }

  const hardLimit = Math.min(after.length, 16000);
  let balance = 0;
  let sawClose = false;
  let end = hardLimit;

  for (let index = 0; index < hardLimit; index += 1) {
    const char = after[index];
    if (char === "{") {
      balance += 1;
      continue;
    }

    if (char === "}") {
      balance -= 1;
      sawClose = true;
      if (balance < 0) {
        const nextLine = after.indexOf("\n", index);
        const closeLineEnd = nextLine >= 0 ? nextLine : index + 1;
        end = closeLineEnd + collectFollowingClosers(after.slice(closeLineEnd)).length;
        break;
      }
    }
  }

  if (!sawClose) {
    const lines = after.split("\n");
    return lines.slice(0, 60).join("\n").trimEnd();
  }

  return after.slice(0, end).trimEnd();
}

function collectFollowingClosers(text) {
  if (!text || !text.startsWith("\n")) {
    return "";
  }

  const lines = text.split("\n");
  const closers = [];

  for (const line of lines.slice(1, 13)) {
    if (!line.trim()) {
      break;
    }

    if (!/^\s*[\}\]\)]+;?\s*$/.test(line)) {
      break;
    }

    closers.push(line);
  }

  return closers.length ? `\n${closers.join("\n")}` : "";
}

function collectNextSignatures(lines, cursorLine) {
  const signatures = [];

  for (let index = cursorLine + 1; index < Math.min(lines.length, cursorLine + 260); index += 1) {
    const line = lines[index] || "";
    if (isSymbolLikeLine(line)) {
      signatures.push(line);
      if (signatures.length >= 6) {
        break;
      }
    }
  }

  return signatures.join("\n").trim();
}

function isSymbolLikeLine(line) {
  const text = line.trim();
  if (!text || text.length > 240) {
    return false;
  }

  return /^(export\s+)?(async\s+)?function\s+/.test(text)
    || /^(export\s+)?(class|struct|interface|enum|namespace)\s+/.test(text)
    || /^(template\s*<.*>\s*)?[\w:<>~*&\s]+\s+[A-Za-z_~][\w:]*\s*\([^;{}]*\)\s*(const\b|noexcept\b|override\b|final\b|->|;|\{)?/.test(text)
    || /^(const|let|var)\s+[A-Za-z_]\w*\s*=\s*(async\s*)?\(/.test(text);
}

function stripLineComment(line) {
  return String(line || "").replace(/\/\/.*$/, "");
}

function countChar(text, char) {
  let count = 0;
  for (const value of text) {
    if (value === char) {
      count += 1;
    }
  }
  return count;
}

function getIndentation(line) {
  const match = String(line || "").match(/^[ \t]*/);
  return match ? match[0] : "";
}

function getFileName(document) {
  if (!document || !document.uri) {
    return "";
  }

  if (document.uri.scheme === "file" && document.uri.fsPath) {
    return path.basename(document.uri.fsPath);
  }

  return document.uri.toString();
}

function normalizeText(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";
}

module.exports = {
  ContextBuilder
};
