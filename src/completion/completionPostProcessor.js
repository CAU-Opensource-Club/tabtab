const { PROMPT_TAG_NAMES } = require("../api/fimPrompt");
const { normalizeNewlines } = require("../shared/textUtils");
const { looksLikeCompleteStatementEnd } = require("./completionContextRules");

const PROMPT_TAG_PATTERN = new RegExp(`</?(${PROMPT_TAG_NAMES.join("|")})>`, "gi");

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
    completion = stripContextBlockDuplication(completion, context.prefix || "", context.suffix || "", metadata.lineSuffix || "");
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
    .replace(PROMPT_TAG_PATTERN, "")
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

function stripContextBlockDuplication(text, prefix, suffix, lineSuffix) {
  let completion = stripRepeatedPrefixBlock(text, prefix);
  completion = truncateAtRepeatedSuffixBlock(completion, [lineSuffix || "", suffix || ""].filter(Boolean).join("\n"));

  if (isExistingContextBlock(completion, prefix, suffix)) {
    return "";
  }

  return completion;
}

function stripRepeatedPrefixBlock(text, prefix) {
  const completionLines = significantLineRecords(text);
  const prefixLines = significantLineRecords(tail(prefix, 8000)).slice(-120);
  const maxLength = Math.min(6, completionLines.length, prefixLines.length);

  for (let length = maxLength; length > 0; length -= 1) {
    const candidate = completionLines.slice(0, length);
    if (!isUsefulContextBlock(candidate)) {
      continue;
    }

    if (findLineWindow(prefixLines, candidate) >= 0) {
      return text.slice(candidate[candidate.length - 1].nextStart).replace(/^\n+/, "");
    }
  }

  return text;
}

function truncateAtRepeatedSuffixBlock(text, suffix) {
  const completionLines = significantLineRecords(text);
  const suffixLines = significantLineRecords(head(suffix, 8000)).slice(0, 120);
  let cutOffset = undefined;

  for (let start = 0; start < Math.min(3, suffixLines.length); start += 1) {
    const maxLength = Math.min(6, suffixLines.length - start);

    for (let length = maxLength; length > 0; length -= 1) {
      const candidate = suffixLines.slice(start, start + length);
      if (!isUsefulContextBlock(candidate)) {
        continue;
      }

      const matchIndex = findLineWindow(completionLines, candidate);
      if (matchIndex >= 0) {
        const matchOffset = completionLines[matchIndex].start;
        cutOffset = cutOffset === undefined ? matchOffset : Math.min(cutOffset, matchOffset);
        break;
      }
    }
  }

  return cutOffset === undefined ? text : text.slice(0, cutOffset).trimEnd();
}

function isExistingContextBlock(text, prefix, suffix) {
  const completionLines = significantLineRecords(text);
  if (!isUsefulContextBlock(completionLines)) {
    return false;
  }

  return findLineWindow(significantLineRecords(tail(prefix, 8000)), completionLines) >= 0
    || findLineWindow(significantLineRecords(head(suffix, 8000)), completionLines) >= 0;
}

function findLineWindow(lines, candidate) {
  if (!candidate.length || lines.length < candidate.length) {
    return -1;
  }

  for (let index = 0; index <= lines.length - candidate.length; index += 1) {
    let matched = true;

    for (let offset = 0; offset < candidate.length; offset += 1) {
      if (lines[index + offset].normalized !== candidate[offset].normalized) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return index;
    }
  }

  return -1;
}

function isUsefulContextBlock(lines) {
  if (!lines.length || !lines.some((line) => hasIdentifier(line.normalized))) {
    return false;
  }

  const totalLength = lines.reduce((total, line) => total + line.normalized.length, 0);
  return lines.length === 1
    ? totalLength >= 60
    : totalLength >= 40;
}

function significantLineRecords(text) {
  const lines = String(text || "").split("\n");
  const records = [];
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = normalizeCodeLine(line);
    const start = offset;
    const end = start + line.length;
    const nextStart = end + (index < lines.length - 1 ? 1 : 0);

    if (normalized) {
      records.push({
        normalized,
        start,
        nextStart
      });
    }

    offset = nextStart;
  }

  return records;
}

function normalizeCodeLine(line) {
  return String(line || "").trim().replace(/\s+/g, " ");
}

function hasIdentifier(text) {
  return /[A-Za-z_$][\w$]*/.test(text) && !/^[{}()[\],;.\s]+$/.test(text);
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

module.exports = {
  CompletionPostProcessor
};
