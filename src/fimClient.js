const DEFAULT_PROVIDER = "openai";

class FimClient {
  constructor(options = {}) {
    this.output = options.output;
    this.defaults = {
      baseUrl: options.defaultBaseUrl || "https://api.deepseek.com",
      anthropicBaseUrl: options.defaultAnthropicBaseUrl || "https://api.anthropic.com",
      model: options.defaultModel || "deepseek-v4-flash",
      anthropicModel: options.defaultAnthropicModel || "claude-sonnet-4-6",
      systemPrompt: options.defaultSystemPrompt || "You are a code completion engine. Return only inserted code."
    };
  }

  async complete({ runtimeConfig, context, config, token, signal }) {
    const provider = normalizeProvider(runtimeConfig.provider);
    const request = provider === "anthropic"
      ? this.buildAnthropicRequest(runtimeConfig, context, config)
      : this.buildOpenAiRequest(runtimeConfig, context, config);
    const startedAt = Date.now();

    this.log(`[${new Date().toISOString()}] ${getProviderLabel(provider)} FIM start url=${request.url} model=${request.body.model} maxTokens=${request.body.max_tokens}`);

    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal
      });

      if (token && token.isCancellationRequested) {
        this.logReturn("cancelled", startedAt, provider);
        return "";
      }

      if (!response.ok) {
        this.logReturn(response.status, startedAt, provider);
        const text = await response.text();
        this.log(`${getProviderLabel(provider)} FIM error ${response.status}: ${text.slice(0, 500)}`);
        return "";
      }

      const data = await response.json();
      this.logReturn(response.status, startedAt, provider);
      return provider === "anthropic"
        ? extractAnthropicCompletion(data)
        : extractOpenAiCompletion(data);
    } catch (error) {
      if (error && error.name === "AbortError") {
        this.logReturn("aborted", startedAt, provider);
        return "";
      }

      this.logReturn("failed", startedAt, provider);
      this.log(`${getProviderLabel(provider)} FIM request failed: ${error.message || String(error)}`);
      return "";
    }
  }

  buildOpenAiRequest(runtimeConfig, context, config) {
    const body = {
      model: runtimeConfig.model || this.defaults.model,
      messages: [
        {
          role: "system",
          content: runtimeConfig.systemPrompt || this.defaults.systemPrompt
        },
        {
          role: "user",
          content: buildFimPrompt(context)
        }
      ],
      temperature: config.temperature,
      max_tokens: config.maxOutputTokens,
      stream: false
    };

    if (config.sendThinkingDisabled) {
      body.thinking = { type: "disabled" };
    }

    return {
      url: buildOpenAiUrl(runtimeConfig.baseUrl || this.defaults.baseUrl),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${runtimeConfig.apiKey}`
      },
      body
    };
  }

  buildAnthropicRequest(runtimeConfig, context, config) {
    return {
      url: buildAnthropicUrl(runtimeConfig.baseUrl || this.defaults.anthropicBaseUrl),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": runtimeConfig.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: {
        model: runtimeConfig.model || this.defaults.anthropicModel,
        system: runtimeConfig.systemPrompt || this.defaults.systemPrompt,
        messages: [
          {
            role: "user",
            content: buildFimPrompt(context)
          }
        ],
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        stream: false
      }
    };
  }

  logReturn(status, startedAt, provider) {
    this.log(`[${new Date().toISOString()}] ${getProviderLabel(provider)} FIM return status=${status} elapsedMs=${Date.now() - startedAt}`);
  }

  log(message) {
    if (this.output && typeof this.output.appendLine === "function") {
      this.output.appendLine(message);
    }
  }
}

function buildFimPrompt(context) {
  const metadata = context.metadata || {};
  const extra = context.extraContext && context.extraContext.trim()
    ? ["<extra_context>", context.extraContext, "</extra_context>", ""]
    : [];
  const cursorInstructions = buildCursorInstructions(metadata);

  return [
    `Language: ${metadata.languageId || "unknown"}`,
    `File: ${metadata.fileName || "unknown"}`,
    `Cursor: line ${metadata.line || 0}, column ${metadata.character || 0}`,
    "",
    "Fill the cursor gap using FIM.",
    "Return only the inserted text.",
    "Do not return Markdown, explanations, tags, or code that already exists in prefix or suffix.",
    "Prefer a short local completion. The returned text will be inserted exactly at <cursor>.",
    ...cursorInstructions,
    "",
    ...extra,
    "<fim_prefix>",
    context.prefix || "",
    "</fim_prefix>",
    "<fim_suffix>",
    context.suffix || "",
    "</fim_suffix>"
  ].join("\n");
}

function buildCursorInstructions(metadata) {
  const cursorComment = metadata.cursorComment || {};
  if (!cursorComment.inside) {
    return [];
  }

  if (cursorComment.kind === "block") {
    return [
      "Cursor context: inside a block comment. Continue the comment text in the current comment style. Do not switch to code."
    ];
  }

  return [
    "Cursor context: inside a line comment. Continue the comment text in the current comment style. Do not switch to code."
  ];
}

function normalizeProvider(value) {
  return value === "anthropic" ? "anthropic" : DEFAULT_PROVIDER;
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

function getProviderLabel(provider) {
  return provider === "anthropic" ? "Anthropic-compatible format" : "OpenAI-compatible format";
}

module.exports = {
  FimClient,
  buildFimPrompt
};
