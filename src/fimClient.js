const DEFAULT_PROVIDER = "openai";
const FIXED_FIM_RULES = [
  "Fill the cursor gap using FIM.",
  "Return only the inserted text.",
  "Do not return Markdown, explanations, tags, or code that already exists in prefix or suffix.",
  "Prefer a short local completion. The returned text will be inserted exactly at <cursor>."
];
const WORKSPACE_STRATEGY = [
  "Use project profile, diagnostics, and related context as supporting information for the cursor completion.",
  "Prefer the current file prefix and suffix when workspace context conflicts with local code."
];

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
    const stopSequences = buildStopSequences(context);
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

    if (stopSequences.length) {
      body.stop = stopSequences;
    }

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
    const stopSequences = buildStopSequences(context);
    const body = {
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
    };

    if (stopSequences.length) {
      body.stop_sequences = stopSequences;
    }

    return {
      url: buildAnthropicUrl(runtimeConfig.baseUrl || this.defaults.anthropicBaseUrl),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": runtimeConfig.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body
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
  const diagnosticContextSections = Array.isArray(context.cachedContextSections)
    ? context.cachedContextSections.map((section) => String(section || "").trim()).filter(Boolean)
    : [];
  const extra = context.extraContext && context.extraContext.trim()
    ? ["<extra_context>", context.extraContext, "</extra_context>", ""]
    : [];
  const projectProfile = sanitizeProjectProfile(context.projectProfile);

  return [
    ...FIXED_FIM_RULES,
    "",
    ...formatProjectProfileSection(projectProfile),
    ...formatWorkspaceStrategySection(),
    ...formatMetadataSection(metadata),
    ...formatDiagnosticContextSections(diagnosticContextSections),
    ...extra,
    "<fim_prefix>",
    context.prefix || "",
    "</fim_prefix>",
    "<fim_suffix>",
    context.suffix || "",
    "</fim_suffix>"
  ].join("\n");
}

function buildStopSequences(context) {
  const metadata = context && context.metadata ? context.metadata : {};
  const suffixText = [
    metadata.lineSuffix || "",
    context && context.suffix ? context.suffix : ""
  ].filter(Boolean).join("\n");
  const sequences = [];
  const seen = new Set();

  for (const line of normalizeNewlines(suffixText).split("\n")) {
    const sequence = line.replace(/[ \t]+$/g, "");
    const normalized = sequence.trim().replace(/\s+/g, " ");

    if (!isUsefulStopSequence(sequence) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    sequences.push(sequence.slice(0, 160));

    if (sequences.length >= 3) {
      break;
    }
  }

  return sequences;
}

function isUsefulStopSequence(line) {
  const text = String(line || "").trim();

  return text.length >= 24
    && !/^<\/?(fim_prefix|fim_suffix|project_profile|workspace_strategy|metadata|diagnostics_context|extra_context|before_cursor|after_cursor|cursor)>$/i.test(text)
    && !/^[{}()[\],;.\s]+$/.test(text);
}

function formatProjectProfileSection(projectProfile) {
  if (!projectProfile) {
    return [];
  }

  return [
    "<project_profile>",
    `Project profile: ${projectProfile}`,
    "</project_profile>",
    ""
  ];
}

function formatWorkspaceStrategySection() {
  return [
    "<workspace_strategy>",
    WORKSPACE_STRATEGY.join("\n"),
    "</workspace_strategy>",
    ""
  ];
}

function formatMetadataSection(metadata) {
  const lines = [
    `Language: ${metadata.languageId || "unknown"}`,
    `File: ${metadata.fileName || "unknown"}`,
    ...buildCursorInstructions(metadata)
  ];

  return [
    "<metadata>",
    lines.join("\n"),
    "</metadata>",
    ""
  ];
}

function formatDiagnosticContextSections(sections) {
  if (!sections.length) {
    return [];
  }

  return [
    "<diagnostics_context>",
    sections.join("\n\n"),
    "</diagnostics_context>",
    ""
  ];
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

function sanitizeProjectProfile(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function normalizeNewlines(text) {
  return String(text || "").replace(/\r\n/g, "\n");
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
