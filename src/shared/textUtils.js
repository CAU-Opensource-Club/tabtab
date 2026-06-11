function stripBom(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function normalizeNewlines(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";
}

function replaceControlChars(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ");
}

function sanitizeSingleLine(value, maxChars) {
  const text = replaceControlChars(value).replace(/\s+/g, " ").trim();
  return Number.isFinite(maxChars) ? text.slice(0, maxChars) : text;
}

module.exports = {
  stripBom,
  normalizeNewlines,
  replaceControlChars,
  sanitizeSingleLine
};
