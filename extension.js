const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { InlineCompletionProvider } = require("./src/inlineCompletionProvider");

const SECRET_KEY = "tabtab.deepseekApiKey";
const CONFIG_FILE_NAME = "tabtab.config.json";
const SYSTEM_PROMPT_FILE_NAME = "tabtab.system-prompt.txt";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_SYSTEM_PROMPT = `You are a code completion engine, not a chat assistant.

Complete the code at the cursor using the surrounding file context.

Rules:
- Return only the code completion text.
- Do not use Markdown.
- Do not explain.
- Do not repeat code that already exists before and after the cursor.
- Keep the completion minimal and local.
- Prefer the style, naming, formatting, and abstractions already used in the file.
- Do not introduce large refactors.
- Do not invent unrelated APIs.
- Prefer simple, readable, type-safe code.
- For C++, prefer modern C++17/20 style, RAII, constexpr where useful, strong typing where appropriate, and avoid unnecessary dynamic allocation.
- In hot-path or systems code, avoid hidden allocations, exceptions, virtual dispatch, locks, and excessive abstraction unless the surrounding code already uses them.
- Preserve const-correctness, noexcept, alignment, and cache-conscious layout when relevant.
- Complete only what is very likely intended from the immediate context.`;

let output;

async function activate(context) {
  output = vscode.window.createOutputChannel("TabTab");
  const initialConfig = await ensureConfigFile(context);

  const provider = new InlineCompletionProvider({
    vscode,
    context,
    output,
    readRuntimeConfig: () => readTabTabConfig(context),
    defaults: {
      defaultBaseUrl: DEFAULT_BASE_URL,
      defaultAnthropicBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
      defaultModel: DEFAULT_MODEL,
      defaultAnthropicModel: DEFAULT_ANTHROPIC_MODEL,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT
    }
  });
  const settingsProvider = new TabTabSettingsViewProvider(context);
  const documentSelector = [
    { scheme: "file" },
    { scheme: "untitled" }
  ];

  context.subscriptions.push(
    output,
    vscode.languages.registerInlineCompletionItemProvider(documentSelector, provider),
    vscode.window.registerWebviewViewProvider(TabTabSettingsViewProvider.viewType, settingsProvider),
    vscode.commands.registerCommand("tabtab.setApiKey", async () => {
      await setApiKey(context);
      await settingsProvider.refresh();
    }),
    vscode.commands.registerCommand("tabtab.clearApiKey", async () => {
      await clearApiKey(context);
      await settingsProvider.refresh();
    }),
    vscode.commands.registerCommand("tabtab.testApi", async () => {
      await testApiConnection(context);
    })
  );

  output.appendLine(`TabTab activated. provider=${getProviderLabel(initialConfig.provider)} baseUrl=${initialConfig.baseUrl} model=${initialConfig.model} apiKey=${initialConfig.apiKey ? "set" : "missing"}`);
}

function deactivate() {}

class TabTabSettingsViewProvider {
  static viewType = "tabtab.settingsView";

  constructor(context) {
    this.context = context;
    this.view = undefined;

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("tabtab")) {
          this.refresh();
        }
      })
    );
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message.type !== "string") {
        return;
      }

      if (message.type === "ready") {
        await this.refresh();
        return;
      }

      if (message.type === "save") {
        await this.saveSettings(message.values || {});
        return;
      }

      if (message.type === "clearApiKey") {
        await clearApiKey(this.context);
        await this.refresh("API key cleared.");
        return;
      }

      if (message.type === "testApi") {
        await testApiConnection(this.context);
        await this.refresh("API test finished. Check Output > TabTab.");
      }
    });
  }

  async refresh(notice = "") {
    if (!this.view) {
      return;
    }

    const config = await readTabTabConfig(this.context);

    await this.view.webview.postMessage({
      type: "state",
      notice,
      settings: {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        systemPrompt: config.systemPrompt
      },
      apiKey: {
        isSet: Boolean(config.apiKey)
      },
      defaults: {
        baseUrl: DEFAULT_BASE_URL,
        anthropicBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
        model: DEFAULT_MODEL,
        anthropicModel: DEFAULT_ANTHROPIC_MODEL,
        systemPrompt: DEFAULT_SYSTEM_PROMPT
      }
    });
  }

  async saveSettings(values) {
    let provider;
    let baseUrl;
    let model;
    let systemPrompt;

    try {
      provider = normalizeProvider(values.provider);
      baseUrl = normalizeBaseUrl(values.baseUrl);
      model = normalizeRequiredString(values.model, "Model name");
      systemPrompt = normalizeRequiredString(values.systemPrompt, "System prompt");
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      vscode.window.showErrorMessage(message);
      await this.refresh(message);
      return;
    }

    const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    await writeTabTabConfig(this.context, {
      provider,
      baseUrl,
      model,
      apiKey,
      systemPrompt
    });

    vscode.window.showInformationMessage(`TabTab settings saved to ${CONFIG_FILE_NAME} and ${SYSTEM_PROMPT_FILE_NAME}.`);
    await this.refresh(`Saved to ${CONFIG_FILE_NAME} and ${SYSTEM_PROMPT_FILE_NAME}.`);
  }

  getHtml(webview) {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>TabTab Settings</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    body {
      margin: 0;
      padding: 14px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-weight) var(--vscode-font-size) / 1.45 var(--vscode-font-family);
    }

    form {
      display: grid;
      gap: 14px;
    }

    label {
      display: grid;
      gap: 6px;
      color: var(--vscode-foreground);
      font-weight: 600;
    }

    input,
    select,
    textarea {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 7px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }

    textarea {
      min-height: 220px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
      line-height: 1.45;
    }

    input:focus,
    select:focus,
    textarea:focus,
    button:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .actions {
      display: grid;
      gap: 8px;
      grid-template-columns: 1fr;
    }

    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      padding: 7px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: inherit;
      cursor: pointer;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .status {
      min-height: 18px;
      color: var(--vscode-descriptionForeground);
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <form id="settings-form">
    <label>
      API Format
      <select id="provider">
        <option value="openai">OpenAI-compatible format</option>
        <option value="anthropic">Anthropic-compatible format</option>
      </select>
    </label>

    <label>
      API URL
      <input id="baseUrl" type="url" spellcheck="false" autocomplete="off" required>
    </label>

    <label>
      Model
      <input id="model" type="text" spellcheck="false" autocomplete="off" required>
    </label>

    <label>
      API Key
      <input id="apiKey" type="password" spellcheck="false" autocomplete="off">
    </label>

    <label>
      System Prompt
      <textarea id="systemPrompt" spellcheck="false" required></textarea>
    </label>

    <div class="actions">
      <button id="save" type="submit">Save</button>
      <button id="testApi" class="secondary" type="button">Test API</button>
      <button id="resetPrompt" class="secondary" type="button">Reset Prompt</button>
      <button id="clearApiKey" class="secondary" type="button">Clear API Key</button>
    </div>

    <div id="status" class="status" aria-live="polite"></div>
  </form>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById("settings-form");
    const provider = document.getElementById("provider");
    const baseUrl = document.getElementById("baseUrl");
    const model = document.getElementById("model");
    const apiKey = document.getElementById("apiKey");
    const systemPrompt = document.getElementById("systemPrompt");
    const status = document.getElementById("status");
    const save = document.getElementById("save");
    const testApi = document.getElementById("testApi");
    const resetPrompt = document.getElementById("resetPrompt");
    const clearApiKey = document.getElementById("clearApiKey");

    let defaultSystemPrompt = "";
    let defaultBaseUrl = "";
    let defaultAnthropicBaseUrl = "";
    let defaultModel = "";
    let defaultAnthropicModel = "";

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "state") {
        return;
      }

      provider.value = message.settings.provider || "openai";
      baseUrl.value = message.settings.baseUrl || "";
      model.value = message.settings.model || "";
      apiKey.value = message.settings.apiKey || "";
      systemPrompt.value = message.settings.systemPrompt || "";
      defaultBaseUrl = message.defaults.baseUrl || "";
      defaultAnthropicBaseUrl = message.defaults.anthropicBaseUrl || "";
      defaultModel = message.defaults.model || "";
      defaultAnthropicModel = message.defaults.anthropicModel || "";
      defaultSystemPrompt = message.defaults.systemPrompt || "";

      const hasApiKey = Boolean(message.apiKey && message.apiKey.isSet);
      apiKey.placeholder = hasApiKey
        ? "Stored in ${CONFIG_FILE_NAME}"
        : "Paste an API key";

      status.textContent = message.notice || "Config: ${CONFIG_FILE_NAME}; prompt: ${SYSTEM_PROMPT_FILE_NAME}; API key " + (hasApiKey ? "set" : "empty");
      save.disabled = false;
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      save.disabled = true;
      status.textContent = "Saving...";

      vscode.postMessage({
        type: "save",
        values: {
          provider: provider.value,
          baseUrl: baseUrl.value,
          model: model.value,
          apiKey: apiKey.value,
          systemPrompt: systemPrompt.value
        }
      });
    });

    resetPrompt.addEventListener("click", () => {
      systemPrompt.value = defaultSystemPrompt;
      status.textContent = "Default prompt restored.";
    });

    clearApiKey.addEventListener("click", () => {
      vscode.postMessage({ type: "clearApiKey" });
    });

    testApi.addEventListener("click", () => {
      status.textContent = "Testing API...";
      vscode.postMessage({ type: "testApi" });
    });

    provider.addEventListener("change", () => {
      if (provider.value === "anthropic") {
        if (!baseUrl.value || baseUrl.value === defaultBaseUrl) {
          baseUrl.value = defaultAnthropicBaseUrl;
        }

        if (!model.value || model.value === defaultModel) {
          model.value = defaultAnthropicModel;
        }
      } else {
        if (!baseUrl.value || baseUrl.value === defaultAnthropicBaseUrl) {
          baseUrl.value = defaultBaseUrl;
        }

        if (!model.value || model.value === defaultAnthropicModel) {
          model.value = defaultModel;
        }
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

async function setApiKey(context) {
  const apiKey = await vscode.window.showInputBox({
    prompt: "Enter your API key",
    password: true,
    ignoreFocusOut: true
  });

  if (!apiKey || !apiKey.trim()) {
    return;
  }

  const config = await readTabTabConfig(context);
  await writeTabTabConfig(context, {
    ...config,
    apiKey: apiKey.trim()
  });
  await context.secrets.delete(SECRET_KEY);
  vscode.window.showInformationMessage(`TabTab API key saved to ${CONFIG_FILE_NAME}.`);
}

async function clearApiKey(context) {
  const config = await readTabTabConfig(context);
  await writeTabTabConfig(context, {
    ...config,
    apiKey: ""
  });
  await context.secrets.delete(SECRET_KEY);
  vscode.window.showInformationMessage(`TabTab API key cleared from ${CONFIG_FILE_NAME}.`);
}

async function getApiKey(context) {
  const config = await readTabTabConfig(context);
  return config.apiKey;
}

async function ensureConfigFile(context) {
  return readTabTabConfig(context);
}

async function readTabTabConfig(context) {
  const configPath = getConfigFilePath(context);
  const promptPath = getSystemPromptFilePath(context);
  const raw = await readRawConfigFile(configPath);
  const prompt = await readSystemPromptFile(promptPath, raw.config || {});
  const config = await normalizeTabTabConfig(context, raw.config || {}, prompt.systemPrompt);

  if (!raw.hadError && (raw.shouldWrite || shouldNormalizeConfig(raw.config || {}))) {
    await writeConfigFile(configPath, config);
  }

  if (prompt.shouldWrite) {
    await writeSystemPromptFile(promptPath, config.systemPrompt);
  }

  return config;
}

async function writeTabTabConfig(context, nextConfig) {
  const configPath = getConfigFilePath(context);
  const promptPath = getSystemPromptFilePath(context);
  const raw = await readRawConfigFile(configPath);
  const prompt = await readSystemPromptFile(promptPath, raw.config || {});
  const nextPrompt = Object.prototype.hasOwnProperty.call(nextConfig, "systemPrompt")
    ? nextConfig.systemPrompt
    : prompt.systemPrompt;
  const config = await normalizeTabTabConfig(context, {
    ...(raw.config || {}),
    ...nextConfig
  }, nextPrompt);

  await writeConfigFile(configPath, config);
  await writeSystemPromptFile(promptPath, config.systemPrompt);
  return config;
}

async function readRawConfigFile(configPath) {
  if (!configPath) {
    return { config: {}, shouldWrite: false, hadError: false };
  }

  try {
    const raw = await fs.promises.readFile(configPath, "utf8");
    const json = stripBom(raw);
    const config = JSON.parse(json);

    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object.`);
    }

    return { config, shouldWrite: json !== raw, hadError: false };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { config: {}, shouldWrite: true, hadError: false };
    }

    output.appendLine(`Could not read ${CONFIG_FILE_NAME}: ${error.message || String(error)}`);
    return { config: {}, shouldWrite: false, hadError: true };
  }
}

async function readSystemPromptFile(promptPath, config) {
  const fallbackPrompt = getPromptString(config.systemPrompt) || DEFAULT_SYSTEM_PROMPT;

  if (!promptPath) {
    return { systemPrompt: fallbackPrompt, shouldWrite: false };
  }

  try {
    const rawPrompt = await fs.promises.readFile(promptPath, "utf8");
    const prompt = stripBom(rawPrompt);
    const systemPrompt = getPromptString(prompt);
    return {
      systemPrompt: systemPrompt || fallbackPrompt,
      shouldWrite: rawPrompt !== prompt || !systemPrompt
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { systemPrompt: fallbackPrompt, shouldWrite: true };
    }

    output.appendLine(`Could not read ${SYSTEM_PROMPT_FILE_NAME}: ${error.message || String(error)}`);
    return { systemPrompt: fallbackPrompt, shouldWrite: false };
  }
}

async function normalizeTabTabConfig(context, config, systemPrompt) {
  const workspaceConfig = vscode.workspace.getConfiguration("tabtab");
  const legacySecret = await context.secrets.get(SECRET_KEY);
  const provider = normalizeProvider(config.provider);
  const hasApiKey = Object.prototype.hasOwnProperty.call(config, "apiKey");
  const apiKey = hasApiKey
    ? getConfigString(config.apiKey)
    : getConfigString(config.deepseekApiKey) || getConfigString(legacySecret);

  return {
    ...config,
    provider,
    baseUrl: getConfigString(config.baseUrl) || workspaceConfig.get("baseUrl", getDefaultBaseUrl(provider)),
    model: getConfigString(config.model) || workspaceConfig.get("model", getDefaultModel(provider)),
    apiKey,
    systemPrompt: getPromptString(systemPrompt) || workspaceConfig.get("systemPrompt", DEFAULT_SYSTEM_PROMPT)
  };
}

function shouldNormalizeConfig(config) {
  return typeof config.provider !== "string"
    || typeof config.baseUrl !== "string"
    || typeof config.model !== "string"
    || typeof config.apiKey !== "string"
    || Object.prototype.hasOwnProperty.call(config, "systemPrompt")
    || Object.prototype.hasOwnProperty.call(config, "deepseekApiKey");
}

async function writeConfigFile(configPath, config) {
  if (!configPath) {
    return;
  }

  const fileConfig = { ...config };
  delete fileConfig.deepseekApiKey;
  delete fileConfig.systemPrompt;

  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify(fileConfig, null, 2)}\n`, "utf8");
}

async function writeSystemPromptFile(promptPath, systemPrompt) {
  if (!promptPath) {
    return;
  }

  await fs.promises.mkdir(path.dirname(promptPath), { recursive: true });
  await fs.promises.writeFile(promptPath, `${getPromptString(systemPrompt) || DEFAULT_SYSTEM_PROMPT}\n`, "utf8");
}

function getConfigFilePath(context) {
  const extensionRoot = getExtensionRoot(context);
  return extensionRoot ? path.join(extensionRoot, CONFIG_FILE_NAME) : "";
}

function getSystemPromptFilePath(context) {
  const extensionRoot = getExtensionRoot(context);
  return extensionRoot ? path.join(extensionRoot, SYSTEM_PROMPT_FILE_NAME) : "";
}

function getExtensionRoot(context) {
  return context.extensionPath || (context.extensionUri && context.extensionUri.fsPath) || "";
}

function getConfigString(value) {
  return typeof value === "string" ? stripBom(value).trim() : "";
}

function getPromptString(value) {
  return typeof value === "string" ? stripBom(value).replace(/\r\n/g, "\n").trim() : "";
}

function stripBom(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function normalizeProvider(value) {
  return value === "anthropic" ? "anthropic" : DEFAULT_PROVIDER;
}

function getDefaultBaseUrl(provider) {
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
}

function getDefaultModel(provider) {
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_MODEL;
}

function getProviderLabel(provider) {
  return provider === "anthropic" ? "Anthropic-compatible format" : "OpenAI-compatible format";
}

function buildOpenAiUrl(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : `${normalized}/chat/completions`;
}

function buildAnthropicUrl(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");

  if (/\/messages$/i.test(normalized)) {
    return normalized;
  }

  if (/\/v1$/i.test(normalized)) {
    return `${normalized}/messages`;
  }

  return `${normalized}/v1/messages`;
}

async function testApiConnection(context) {
  const runtimeConfig = await readTabTabConfig(context);
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
    logApiReturn(response.status, startedAt, "test", provider);

    if (!response.ok) {
      output.appendLine(`${getProviderLabel(provider)} API test error ${response.status}: ${text.slice(0, 500)}`);
      vscode.window.showErrorMessage(`API test failed: ${response.status}. See Output > TabTab.`);
      return;
    }

    output.appendLine(`${getProviderLabel(provider)} API test response: ${extractResponsePreview(text, provider)}`);
    vscode.window.showInformationMessage("API test succeeded. See Output > TabTab.");
  } catch (error) {
    logApiReturn("failed", startedAt, "test", provider);
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

function logApiReturn(status, startedAt, label = "completion", provider = DEFAULT_PROVIDER) {
  output.appendLine(`[${new Date().toISOString()}] ${getProviderLabel(provider)} API ${label} return status=${status} elapsedMs=${Date.now() - startedAt}`);
}

function extractResponsePreview(text, provider = DEFAULT_PROVIDER) {
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

function extractOpenAiCompletion(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";

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

function normalizeBaseUrl(value) {
  const baseUrl = normalizeRequiredString(value, "API URL").replace(/\/+$/, "");
  const parsed = new URL(baseUrl);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API URL must use http or https.");
  }

  return baseUrl;
}

function normalizeRequiredString(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

function getNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return nonce;
}

module.exports = {
  activate,
  deactivate
};
