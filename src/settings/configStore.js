const fs = require("fs");
const path = require("path");

const {
  CONFIG_FILE_NAME,
  SYSTEM_PROMPT_FILE_NAME,
  LEGACY_API_KEY_SECRET,
  DEFAULT_SYSTEM_PROMPT,
  getDefaultBaseUrl,
  getDefaultModel
} = require("../constants");
const { normalizeProvider } = require("../api/providerFormats");
const {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_CHARS,
  normalizeProjectProfileConfig,
  isProjectProfileConfig
} = require("../projectProfile/profileConfig");
const { stripBom } = require("../shared/textUtils");

class ConfigStore {
  constructor({ vscode, context, output }) {
    this.vscode = vscode;
    this.context = context;
    this.output = output;
  }

  async read() {
    const configPath = this.getConfigFilePath();
    const promptPath = this.getSystemPromptFilePath();
    const raw = await this.readRawConfigFile(configPath);
    const prompt = await this.readSystemPromptFile(promptPath, raw.config || {});
    const config = await this.normalizeConfig(raw.config || {}, prompt.systemPrompt);

    if (!raw.hadError && (raw.shouldWrite || shouldNormalizeConfig(raw.config || {}))) {
      await writeConfigFile(configPath, config);
    }

    if (prompt.shouldWrite) {
      await writeSystemPromptFile(promptPath, config.systemPrompt);
    }

    return config;
  }

  async write(nextConfig) {
    const configPath = this.getConfigFilePath();
    const promptPath = this.getSystemPromptFilePath();
    const raw = await this.readRawConfigFile(configPath);
    const prompt = await this.readSystemPromptFile(promptPath, raw.config || {});
    const nextPrompt = Object.prototype.hasOwnProperty.call(nextConfig, "systemPrompt")
      ? nextConfig.systemPrompt
      : prompt.systemPrompt;
    const config = await this.normalizeConfig({
      ...(raw.config || {}),
      ...nextConfig
    }, nextPrompt);

    await writeConfigFile(configPath, config);
    await writeSystemPromptFile(promptPath, config.systemPrompt);
    return config;
  }

  async saveApiKey(apiKey) {
    await this.write({ apiKey: getConfigString(apiKey) });
    await this.context.secrets.delete(LEGACY_API_KEY_SECRET);
  }

  async clearApiKey() {
    await this.write({ apiKey: "" });
    await this.context.secrets.delete(LEGACY_API_KEY_SECRET);
  }

  async readRawConfigFile(configPath) {
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

      this.log(`Could not read ${CONFIG_FILE_NAME}: ${error.message || String(error)}`);
      return { config: {}, shouldWrite: false, hadError: true };
    }
  }

  async readSystemPromptFile(promptPath, config) {
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

      this.log(`Could not read ${SYSTEM_PROMPT_FILE_NAME}: ${error.message || String(error)}`);
      return { systemPrompt: fallbackPrompt, shouldWrite: false };
    }
  }

  async normalizeConfig(config, systemPrompt) {
    const workspaceConfig = this.vscode.workspace.getConfiguration("tabtab");
    const legacySecret = await this.context.secrets.get(LEGACY_API_KEY_SECRET);
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
      fimEnabled: typeof config.fimEnabled === "boolean"
        ? config.fimEnabled
        : getWorkspaceBoolean(workspaceConfig, "fimEnabled", true),
      systemPrompt: getPromptString(systemPrompt) || workspaceConfig.get("systemPrompt", DEFAULT_SYSTEM_PROMPT),
      projectProfile: getProjectProfileConfig(config, workspaceConfig)
    };
  }

  getConfigFilePath() {
    const extensionRoot = this.getExtensionRoot();
    return extensionRoot ? path.join(extensionRoot, CONFIG_FILE_NAME) : "";
  }

  getSystemPromptFilePath() {
    const extensionRoot = this.getExtensionRoot();
    return extensionRoot ? path.join(extensionRoot, SYSTEM_PROMPT_FILE_NAME) : "";
  }

  getExtensionRoot() {
    return this.context.extensionPath || (this.context.extensionUri && this.context.extensionUri.fsPath) || "";
  }

  log(message) {
    if (this.output && typeof this.output.appendLine === "function") {
      this.output.appendLine(message);
    }
  }
}

function shouldNormalizeConfig(config) {
  return typeof config.provider !== "string"
    || typeof config.baseUrl !== "string"
    || typeof config.model !== "string"
    || typeof config.apiKey !== "string"
    || typeof config.fimEnabled !== "boolean"
    || !isProjectProfileConfig(config.projectProfile)
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

function getProjectProfileConfig(config, workspaceConfig) {
  const source = config && config.projectProfile && typeof config.projectProfile === "object" && !Array.isArray(config.projectProfile)
    ? config.projectProfile
    : {};

  return normalizeProjectProfileConfig({
    enabled: typeof source.enabled === "boolean"
      ? source.enabled
      : workspaceConfig.get("projectProfile.enabled", true),
    manualProfile: typeof source.manualProfile === "string"
      ? source.manualProfile
      : workspaceConfig.get("projectProfile.manualProfile", ""),
    showInStatusBar: typeof source.showInStatusBar === "boolean"
      ? source.showInStatusBar
      : workspaceConfig.get("projectProfile.showInStatusBar", true),
    maxFiles: Number.isFinite(source.maxFiles)
      ? source.maxFiles
      : workspaceConfig.get("projectProfile.maxFiles", DEFAULT_MAX_FILES),
    maxChars: Number.isFinite(source.maxChars)
      ? source.maxChars
      : workspaceConfig.get("projectProfile.maxChars", DEFAULT_MAX_CHARS)
  });
}

function getConfigString(value) {
  return typeof value === "string" ? stripBom(value).trim() : "";
}

function getPromptString(value) {
  return typeof value === "string" ? stripBom(value).replace(/\r\n/g, "\n").trim() : "";
}

function getWorkspaceBoolean(workspaceConfig, key, fallback) {
  const value = workspaceConfig && typeof workspaceConfig.get === "function"
    ? workspaceConfig.get(key, fallback)
    : fallback;
  return typeof value === "boolean" ? value : fallback;
}

module.exports = {
  ConfigStore
};
