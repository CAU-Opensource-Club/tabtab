const { normalizeNewlines } = require("../shared/textUtils");

class TokenBudgeter {
  constructor(options = {}) {
    this.maxPromptTokens = options.maxPromptTokens || 8192;
    this.charsPerToken = options.charsPerToken || 4;
    this.prefixRatio = options.prefixRatio || 0.65;
    this.suffixRatio = options.suffixRatio || 0.20;
    this.extraRatio = options.extraRatio || 0.15;
  }

  budgets() {
    return {
      prefix: Math.floor(this.maxPromptTokens * this.prefixRatio),
      suffix: Math.floor(this.maxPromptTokens * this.suffixRatio),
      extra: Math.max(0, this.maxPromptTokens - Math.floor(this.maxPromptTokens * this.prefixRatio) - Math.floor(this.maxPromptTokens * this.suffixRatio))
    };
  }

  estimateTokens(text) {
    if (!text) {
      return 0;
    }

    return Math.ceil(String(text).length / this.charsPerToken);
  }

  fitPrefixParts(parts) {
    const budget = this.budgets().prefix;
    const imports = this.trimFromEnd(parts.imports || "", Math.floor(budget * 0.12));
    const scope = this.trimFromStart(parts.scope || "", Math.floor(budget * 0.18));
    const adjacent = this.trimFromEnd(parts.adjacent || "", Math.floor(budget * 0.10));
    const used = this.estimateTokens(imports) + this.estimateTokens(scope) + this.estimateTokens(adjacent);
    const localBudget = Math.max(Math.floor(budget * 0.50), budget - used);
    const local = this.trimFromStart(parts.local || "", localBudget);

    return [imports, scope, adjacent, local]
      .filter((part) => part && part.trim())
      .join("\n\n");
  }

  fitSuffixParts(parts) {
    const budget = this.budgets().suffix;
    const currentLine = this.trimFromEnd(parts.currentLine || "", Math.floor(budget * 0.08));
    const signatures = this.trimFromEnd(parts.nextSignatures || "", Math.floor(budget * 0.18));
    const used = this.estimateTokens(currentLine) + this.estimateTokens(signatures);
    const blockBudget = Math.max(Math.floor(budget * 0.65), budget - used);
    const blockTail = this.trimFromEnd(parts.blockTail || "", blockBudget);

    return [currentLine, blockTail, signatures]
      .filter((part) => part && part.trim())
      .join("\n\n");
  }

  fitExtraChunks(chunks) {
    const budget = this.budgets().extra;
    let remaining = budget;
    const selected = [];

    for (const chunk of [...chunks].sort((a, b) => (b.score || 0) - (a.score || 0))) {
      if (!chunk || !chunk.text || remaining <= 0) {
        continue;
      }

      const header = chunk.label ? `// ${chunk.label}\n` : "";
      const textBudget = Math.max(32, Math.min(remaining, Math.floor(budget * 0.45)));
      const fittedText = this.trimFromEnd(chunk.text, textBudget);
      const fitted = `${header}${fittedText}`.trim();
      const cost = this.estimateTokens(fitted);

      if (!fitted || cost <= 0) {
        continue;
      }

      selected.push(fitted);
      remaining -= cost;
    }

    return selected.join("\n\n");
  }

  trimFromStart(text, maxTokens) {
    const normalized = normalizeNewlines(text);
    if (!normalized || this.estimateTokens(normalized) <= maxTokens) {
      return normalized;
    }

    const maxChars = Math.max(0, Math.floor(maxTokens * this.charsPerToken));
    let trimmed = normalized.slice(Math.max(0, normalized.length - maxChars));
    const firstNewline = trimmed.indexOf("\n");

    if (firstNewline >= 0 && firstNewline < trimmed.length - 1) {
      trimmed = trimmed.slice(firstNewline + 1);
    }

    return trimmed.trimStart();
  }

  trimFromEnd(text, maxTokens) {
    const normalized = normalizeNewlines(text);
    if (!normalized || this.estimateTokens(normalized) <= maxTokens) {
      return normalized;
    }

    const maxChars = Math.max(0, Math.floor(maxTokens * this.charsPerToken));
    let trimmed = normalized.slice(0, maxChars);
    const lastNewline = trimmed.lastIndexOf("\n");

    if (lastNewline > 0) {
      trimmed = trimmed.slice(0, lastNewline);
    }

    return trimmed.trimEnd();
  }
}

module.exports = {
  TokenBudgeter
};
