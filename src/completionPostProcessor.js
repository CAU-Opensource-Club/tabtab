const { looksLikeCompleteStatementEnd } = require("./completionContextRules");

class CompletionPostProcessor {
  process({ raw, context, config }) {
    if (!raw || typeof raw !== "string") {
      return "";
    }

    const metadata = context.metadata || {};
    let completion = normalizeNewlines(raw);
    completion = stripCodeFences(completion);
    completion = stripFimTags(completion);
    completion = stripExplanationText(completion);
    completion = stripSpecialTokens(completion);
    completion = stripPrefixDuplication(completion, context.prefix || "", metadata.linePrefix || "");
    completion = stripSuffixDuplication(completion, context.suffix || "", metadata.lineSuffix || "");
    completion = trimToLineLimit(completion, config.maxCompletionLines);
    completion = alignIndentation(completion, metadata.indentation || "", metadata.linePrefix || "");
    completion = insertStatementBoundaryNewline(completion, metadata);
    completion = completion.replace(/[ \t]+$/gm, "").slice(0, Math.max(512, config.maxOutputTokens * 16));

    if (!completion.trim()) {
      return "";
    }

    return completion;
  }
}

function stripCodeFences(text) {
  let completion = text.trim();
  const fenced = completion.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```$/);

  if (fenced) {
    return fenced[1];
  }

  completion = completion.replace(/^```[a-zA-Z0-9_+-]*\n?/, "");
  completion = completion.replace(/\n?```\s*$/, "");
  return completion;
}

function stripFimTags(text) {
  return text
    .replace(/<\/?(fim_prefix|fim_suffix|extra_context|before_cursor|after_cursor|cursor)>/gi, "")
    .replace(/<\|fim_middle\|>|<\|fim_suffix\|>|<\|fim_prefix\|>/gi, "");
}

function stripExplanationText(text) {
  const lines = text.split("\n");

  while (lines.length && isExplanationLine(lines[0])) {
    lines.shift();
  }

  while (lines.length && isTrailingExplanationLine(lines[lines.length - 1])) {
    lines.pop();
  }

  return lines.join("\n").trim();
}

function isExplanationLine(line) {
  const text = line.trim();
  if (!text) {
    return false;
  }

  return /^(here('|’)s|here is|sure|certainly|of course|the completion is|completion:|answer:|insert this|you can use|this code)/i.test(text);
}

function isTrailingExplanationLine(line) {
  const text = line.trim();
  if (!text) {
    return false;
  }

  return /^(this|the code|it |note:|explanation:)/i.test(text);
}

function stripSpecialTokens(text) {
  return text
    .replace(/<\|endoftext\|>/g, "")
    .replace(/<\|eot_id\|>/g, "")
    .replace(/<\/?s>/g, "");
}

function stripPrefixDuplication(text, prefix, linePrefix) {
  let completion = text;

  if (linePrefix && linePrefix.trim() && completion.startsWith(linePrefix)) {
    completion = completion.slice(linePrefix.length);
  }

  const prefixTail = tail(prefix, 4000);
  const overlap = longestOverlap(prefixTail, completion, 1200);
  if (overlap > 0) {
    completion = completion.slice(overlap);
  }

  return completion;
}

function stripSuffixDuplication(text, suffix, lineSuffix) {
  let completion = text;
  const suffixHead = head(suffix || lineSuffix || "", 4000);

  if (!suffixHead.trim()) {
    return completion;
  }

  const overlap = longestOverlap(completion, suffixHead, 1200);
  if (overlap > 0) {
    completion = completion.slice(0, completion.length - overlap);
  }

  const trimmedSuffix = suffixHead.trimStart();
  if (trimmedSuffix) {
    const index = completion.indexOf(trimmedSuffix);
    if (index >= 0) {
      completion = completion.slice(0, index);
    }
  }

  if (lineSuffix && lineSuffix.trim()) {
    const suffixIndex = completion.indexOf(lineSuffix);
    if (suffixIndex >= 0) {
      completion = completion.slice(0, suffixIndex);
    }
  }

  return completion;
}

function trimToLineLimit(text, maxLines) {
  const completion = text.replace(/^\n+/, "");
  const lines = completion.split("\n");

  if (lines.length <= maxLines) {
    return completion.trimEnd();
  }

  return lines.slice(0, maxLines).join("\n").trimEnd();
}

function alignIndentation(text, indentation, linePrefix) {
  const completion = text.replace(/[ \t]+$/gm, "");
  const lines = completion.split("\n");

  if (lines.length <= 1) {
    return completion;
  }

  const currentIndent = indentation || "";
  const firstLinePrefix = linePrefix && linePrefix.trim() ? "" : currentIndent;

  return lines
    .map((line, index) => {
      if (!line.trim()) {
        return "";
      }

      if (index === 0) {
        return firstLinePrefix && !line.startsWith(firstLinePrefix) && !/^[ \t]/.test(line)
          ? `${firstLinePrefix}${line}`
          : line;
      }

      if (/^[ \t]/.test(line)) {
        return line;
      }

      return `${currentIndent}${line}`;
    })
    .join("\n");
}

function insertStatementBoundaryNewline(text, metadata) {
  const completion = String(text || "");

  if (!completion || /^\s*\n/.test(completion)) {
    return completion;
  }

  if (!looksLikeCompleteStatementEnd(metadata.linePrefix || "", metadata.lineSuffix || "")) {
    return completion;
  }

  return `\n${metadata.indentation || ""}${completion.trimStart()}`;
}

function longestOverlap(left, right, maxLength) {
  const max = Math.min(left.length, right.length, maxLength);

  for (let length = max; length > 0; length -= 1) {
    if (left.slice(left.length - length) === right.slice(0, length)) {
      return length;
    }
  }

  return 0;
}

function head(text, maxLength) {
  return String(text || "").slice(0, maxLength);
}

function tail(text, maxLength) {
  const value = String(text || "");
  return value.slice(Math.max(0, value.length - maxLength));
}

function normalizeNewlines(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

module.exports = {
  CompletionPostProcessor
};
