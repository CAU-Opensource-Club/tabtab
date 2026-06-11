const {
  CONFIG_FILE_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ANTHROPIC_MODEL
} = require("../constants");
const {
  normalizeProvider,
  getProviderLabel,
  buildOpenAiUrl,
  buildAnthropicUrl,
  extractOpenAiCompletion,
  extractAnthropicCompletion
} = require("./providerFormats");

async function testApiConnection({ vscode, output, configStore }) {
  const runtimeConfig = await configStore.read();
  const apiKey = runtimeConfig.apiKey;
  const provider = normalizeProvider(runtimeConfig.provider);

  if (!apiKey) {
    output.appendLine(`${getProviderLabel(provider)} API test skipped: missing apiKey in ${CONFIG_FILE_NAME}.`);
    vscode.window.showErrorMessage(`Missing API key. Set apiKey in ${CONFIG_FILE_NAME}.`);
    return;
  }

  const request = provider === "anthropic"
    ? buildAnthropicTestRequest({ apiKey, runtimeConfig })
    : buildOpenAiTestRequest({ apiKey, runtimeConfig });
  const startedAt = Date.now();

  output.show(true);
  output.appendLine(`[${new Date().toISOString()}] ${getProviderLabel(provider)} API test start url=${request.url} model=${request.body.model}`);

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body)
    });

    const text = await response.text();
    logApiReturn(output, response.status, startedAt, provider);

    if (!response.ok) {
      output.appendLine(`${getProviderLabel(provider)} API test error ${response.status}: ${text.slice(0, 500)}`);
      vscode.window.showErrorMessage(`API test failed: ${response.status}. See Output > TabTab.`);
      return;
    }

    output.appendLine(`${getProviderLabel(provider)} API test response: ${extractResponsePreview(text, provider)}`);
    vscode.window.showInformationMessage("API test succeeded. See Output > TabTab.");
  } catch (error) {
    logApiReturn(output, "failed", startedAt, provider);
    output.appendLine(`${getProviderLabel(provider)} API test failed: ${error.message || String(error)}`);
    vscode.window.showErrorMessage("API test failed. See Output > TabTab.");
  }
}

function buildOpenAiTestRequest({ apiKey, runtimeConfig }) {
  const body = {
    model: runtimeConfig.model || DEFAULT_MODEL,
    messages: [
      {
        role: "user",
        content: "Reply exactly: ok"
      }
    ],
    thinking: {
      type: "disabled"
    },
    temperature: 0,
    max_tokens: 4,
    stream: false
  };

  return {
    url: buildOpenAiUrl(runtimeConfig.baseUrl || DEFAULT_BASE_URL),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body
  };
}

function buildAnthropicTestRequest({ apiKey, runtimeConfig }) {
  const body = {
    model: runtimeConfig.model || DEFAULT_ANTHROPIC_MODEL,
    messages: [
      {
        role: "user",
        content: "Reply exactly: ok"
      }
    ],
    temperature: 0,
    max_tokens: 4,
    stream: false
  };

  return {
    url: buildAnthropicUrl(runtimeConfig.baseUrl || DEFAULT_ANTHROPIC_BASE_URL),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body
  };
}

function logApiReturn(output, status, startedAt, provider) {
  output.appendLine(`[${new Date().toISOString()}] ${getProviderLabel(provider)} API test return status=${status} elapsedMs=${Date.now() - startedAt}`);
}

function extractResponsePreview(text, provider) {
  try {
    const data = JSON.parse(text);
    const content = provider === "anthropic"
      ? extractAnthropicCompletion(data)
      : extractOpenAiCompletion(data);
    return typeof content === "string" ? content.slice(0, 80) : "<no text content>";
  } catch (error) {
    return text.slice(0, 80);
  }
}

module.exports = {
  testApiConnection
};
