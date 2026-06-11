const DEFAULT_PROVIDER = "openai";

function normalizeProvider(value) {
  return value === "anthropic" ? "anthropic" : DEFAULT_PROVIDER;
}

function getProviderLabel(provider) {
  return provider === "anthropic" ? "Anthropic-compatible format" : "OpenAI-compatible format";
}

function buildOpenAiUrl(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : `${normalized}/chat/completions`;
}

function buildAnthropicUrl(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");

  if (/\/messages$/i.test(normalized)) {
    return normalized;
  }

  if (/\/v1$/i.test(normalized)) {
    return `${normalized}/messages`;
  }

  return `${normalized}/v1/messages`;
}

function extractOpenAiCompletion(data) {
  const choice = data && data.choices && data.choices[0] ? data.choices[0] : undefined;
  const content = choice && choice.message ? choice.message.content : choice && choice.text;
  return typeof content === "string" ? content : "";
}

function extractAnthropicCompletion(data) {
  const content = data && data.content ? data.content : [];

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => block && block.type === "text" && typeof block.text === "string" ? block.text : "")
    .join("");
}

module.exports = {
  DEFAULT_PROVIDER,
  normalizeProvider,
  getProviderLabel,
  buildOpenAiUrl,
  buildAnthropicUrl,
  extractOpenAiCompletion,
  extractAnthropicCompletion
};
