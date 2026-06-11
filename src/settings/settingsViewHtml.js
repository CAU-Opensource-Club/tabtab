const { CONFIG_FILE_NAME, SYSTEM_PROMPT_FILE_NAME } = require("../constants");

function renderSettingsViewHtml({ cspSource }) {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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

    textarea.compact {
      min-height: 86px;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .checkbox-label input {
      width: auto;
      margin: 0;
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

    .detected-profile {
      margin-top: -8px;
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

    <label class="checkbox-label">
      <input id="projectProfileEnabled" type="checkbox">
      <span>Generate Project Profile</span>
    </label>

    <label>
      Project Profile
      <textarea id="projectProfileManualProfile" class="compact" spellcheck="false" maxlength="200"></textarea>
    </label>

    <div id="detectedProjectProfile" class="status detected-profile"></div>

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
    const projectProfileEnabled = document.getElementById("projectProfileEnabled");
    const projectProfileManualProfile = document.getElementById("projectProfileManualProfile");
    const detectedProjectProfile = document.getElementById("detectedProjectProfile");
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
      if (!message || (message.type !== "state" && message.type !== "projectProfile")) {
        return;
      }

      if (message.type === "projectProfile") {
        applyProjectProfileState(message.projectProfile || {});
        if (message.notice) {
          status.textContent = message.notice;
        }
        return;
      }

      provider.value = message.settings.provider || "openai";
      baseUrl.value = message.settings.baseUrl || "";
      model.value = message.settings.model || "";
      apiKey.value = message.settings.apiKey || "";
      systemPrompt.value = message.settings.systemPrompt || "";
      applyProjectProfileState(message.projectProfile || {});
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

    function applyProjectProfileState(projectProfile) {
      projectProfileEnabled.checked = Boolean(projectProfile.enabled);
      projectProfileManualProfile.value = projectProfile.manualProfile || "";
      projectProfileManualProfile.placeholder = projectProfile.detectedProfile || "";
      detectedProjectProfile.textContent = projectProfile.detectedProfile
        ? "Detected: " + projectProfile.detectedProfile
        : "Detected: empty";
    }

    function getProjectProfileValues() {
      return {
        projectProfileEnabled: projectProfileEnabled.checked,
        projectProfileManualProfile: projectProfileManualProfile.value
      };
    }

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
          systemPrompt: systemPrompt.value,
          projectProfileEnabled: projectProfileEnabled.checked,
          projectProfileManualProfile: projectProfileManualProfile.value
        }
      });
    });

    resetPrompt.addEventListener("click", () => {
      systemPrompt.value = defaultSystemPrompt;
      status.textContent = "Default prompt restored.";
    });

    projectProfileEnabled.addEventListener("change", () => {
      status.textContent = projectProfileEnabled.checked
        ? "Generating project profile..."
        : "Project profile disabled.";
      vscode.postMessage({
        type: "projectProfileChanged",
        values: getProjectProfileValues(),
        detect: projectProfileEnabled.checked,
        force: projectProfileEnabled.checked,
        notice: projectProfileEnabled.checked
          ? "Project profile generated."
          : "Project profile disabled."
      });
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

function getNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return nonce;
}

module.exports = {
  renderSettingsViewHtml
};
