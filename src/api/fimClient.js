const {
  DEFAULT_BASE_URL,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_SYSTEM_PROMPT
} = require("../constants");
const {
  normalizeProvider,
  getProviderLabel,
  buildOpenAiUrl,
  buildAnthropicUrl,
  extractOpenAiCompletion,
  extractAnthropicCompletion
} = require("./providerFormats");
const { buildFimPrompt, buildStopSequences } = require("./fimPrompt");

class FimClient {
  constructor(options = {}) {
    this.output = options.output;
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
      model: runtimeConfig.model || DEFAULT_MODEL,
      messages: [
        {
          role: "system",
          content: runtimeConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT
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
      url: buildOpenAiUrl(runtimeConfig.baseUrl || DEFAULT_BASE_URL),
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
      model: runtimeConfig.model || DEFAULT_ANTHROPIC_MODEL,
      system: runtimeConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT,
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
      url: buildAnthropicUrl(runtimeConfig.baseUrl || DEFAULT_ANTHROPIC_BASE_URL),
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

module.exports = {
  FimClient
};
