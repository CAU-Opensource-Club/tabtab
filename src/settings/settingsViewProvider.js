const {
  CONFIG_FILE_NAME,
  SYSTEM_PROMPT_FILE_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_SYSTEM_PROMPT
} = require("../constants");
const { normalizeProvider } = require("../api/providerFormats");
const { sanitizeProfile, normalizeProjectProfileConfig } = require("../projectProfile/profileConfig");
const { renderSettingsViewHtml } = require("./settingsViewHtml");

class TabTabSettingsViewProvider {
  static viewType = "tabtab.settingsView";

  constructor({ vscode, context, configStore, projectProfileService, clearApiKey, testApiConnection }) {
    this.vscode = vscode;
    this.context = context;
    this.configStore = configStore;
    this.projectProfileService = projectProfileService;
    this.clearApiKey = clearApiKey;
    this.testApiConnection = testApiConnection;
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

    webviewView.webview.html = renderSettingsViewHtml({ cspSource: webviewView.webview.cspSource });

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

      if (message.type === "projectProfileChanged") {
        await this.updateProjectProfileSettings(message.values || {}, {
          detect: message.detect === true,
          force: message.force === true
        });
        await this.refreshProjectProfile(message.notice || "Project profile settings updated.");
        return;
      }

      if (message.type === "clearApiKey") {
        await this.clearApiKey();
        await this.refresh("API key cleared.");
        return;
      }

      if (message.type === "testApi") {
        await this.testApiConnection();
        await this.refresh("API test finished. Check Output > TabTab.");
      }
    });
  }

  async refresh(notice = "") {
    if (!this.view) {
      return;
    }

    const config = await this.configStore.read();
    const projectProfile = this.getProjectProfileState(config);

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
      projectProfile,
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

  async refreshProjectProfile(notice = "") {
    if (!this.view) {
      return;
    }

    const config = await this.configStore.read();

    await this.view.webview.postMessage({
      type: "projectProfile",
      notice,
      projectProfile: this.getProjectProfileState(config)
    });
  }

  getProjectProfileState(config) {
    const projectProfileConfig = this.projectProfileService
      ? this.projectProfileService.getProjectProfileConfig()
      : config.projectProfile;
    const detectedProfile = this.projectProfileService
      ? this.projectProfileService.getDisplayProfile(this.projectProfileService.getActiveDocument())
      : "";

    return {
      enabled: projectProfileConfig.enabled === true,
      manualProfile: sanitizeProfile(projectProfileConfig.manualProfile),
      detectedProfile
    };
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
      this.vscode.window.showErrorMessage(message);
      await this.refresh(message);
      return;
    }

    const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    await this.configStore.write({
      provider,
      baseUrl,
      model,
      apiKey,
      systemPrompt
    });
    await this.updateProjectProfileSettings(values, {
      detect: values.projectProfileEnabled === true && !sanitizeProfile(values.projectProfileManualProfile)
    });

    this.vscode.window.showInformationMessage(`TabTab settings saved to ${CONFIG_FILE_NAME} and ${SYSTEM_PROMPT_FILE_NAME}.`);
    await this.refresh(`Saved to ${CONFIG_FILE_NAME} and ${SYSTEM_PROMPT_FILE_NAME}.`);
  }

  async updateProjectProfileSettings(values, { detect = false, force = false } = {}) {
    if (
      !Object.prototype.hasOwnProperty.call(values, "projectProfileEnabled")
      && !Object.prototype.hasOwnProperty.call(values, "projectProfileManualProfile")
    ) {
      return;
    }

    const enabled = values.projectProfileEnabled === true;
    const manualProfile = sanitizeProfile(values.projectProfileManualProfile);
    const currentConfig = this.projectProfileService
      ? this.projectProfileService.getProjectProfileConfig()
      : (await this.configStore.read()).projectProfile;
    const nextConfig = normalizeProjectProfileConfig({
      ...currentConfig,
      enabled,
      manualProfile
    });

    if (this.projectProfileService) {
      await this.projectProfileService.updateProjectProfileConfig(nextConfig, {
        detect,
        force
      });
      return;
    }

    await this.configStore.write({
      projectProfile: nextConfig
    });
  }
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

module.exports = {
  TabTabSettingsViewProvider
};
