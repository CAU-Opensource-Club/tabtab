const IMPORT_LINE_PATTERN = /^\s*(#\s*(include|import)|import\s|from\s+\S+\s+import\s|using\s+|package\s+|const\s+\w+\s*=\s*require\(|var\s+\w+\s*=\s*require\(|let\s+\w+\s*=\s*require\()/;
const PRAGMA_ONCE_PATTERN = /^\s*#\s*pragma\s+once\b/;

function collectTopImports(lines, maxScanLines) {
  const imports = [];

  for (const line of lines.slice(0, maxScanLines)) {
    if (IMPORT_LINE_PATTERN.test(line) || PRAGMA_ONCE_PATTERN.test(line)) {
      imports.push(line);
    }
  }

  return imports.join("\n").trim();
}

function isSymbolLikeLine(line, maxLength) {
  const text = line.trim();
  if (!text || text.length > maxLength) {
    return false;
  }

  return /^(export\s+)?(async\s+)?function\s+/.test(text)
    || /^(export\s+)?(class|struct|interface|enum|namespace)\s+/.test(text)
    || /^(template\s*<.*>\s*)?[\w:<>~*&\s]+\s+[A-Za-z_~][\w:]*\s*\([^;{}]*\)\s*(const\b|noexcept\b|override\b|final\b|->|;|\{)?/.test(text)
    || /^(const|let|var)\s+[A-Za-z_]\w*\s*=\s*(async\s*)?\(/.test(text);
}

module.exports = {
  collectTopImports,
  isSymbolLikeLine
};
