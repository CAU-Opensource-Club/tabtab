const DEFAULT_COMPLETION_CONFIG = {
  debounceMs: 800,
  maxPromptTokens: 8192,
  maxOutputTokens: 128,
  manualMaxOutputTokens: 256,
  temperature: 0.1,
  requestTimeoutMs: 8000,
  automaticMaxLines: 8,
  manualMaxLines: 24,
  maxRelatedFiles: 6,
  maxRelatedFileBytes: 256 * 1024,
  lspTimeoutMs: 250,
  idleTriggerEnabled: true,
  idleTriggerMs: 1500,
  idleTriggerCooldownMs: 3000,
  sendThinkingDisabled: true
};

class CompletionConfig {
  constructor(values) {
    Object.assign(this, values);
  }

  static fromWorkspace(workspaceConfig, inlineContext, vscode) {
    const isManual = Boolean(
      vscode
        && inlineContext
        && inlineContext.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
    );
    const legacyMaxTokens = getNumber(workspaceConfig, "maxTokens", DEFAULT_COMPLETION_CONFIG.maxOutputTokens);
    const maxOutputTokens = isManual
      ? getNumber(workspaceConfig, "manualMaxOutputTokens", Math.max(DEFAULT_COMPLETION_CONFIG.manualMaxOutputTokens, legacyMaxTokens))
      : getNumber(workspaceConfig, "maxOutputTokens", legacyMaxTokens);

    return new CompletionConfig({
      enabled: getBoolean(workspaceConfig, "enabled", true),
      isManual,
      debounceMs: getNumber(workspaceConfig, "debounceMs", DEFAULT_COMPLETION_CONFIG.debounceMs),
      maxPromptTokens: getNumber(workspaceConfig, "maxPromptTokens", DEFAULT_COMPLETION_CONFIG.maxPromptTokens),
      maxOutputTokens,
      temperature: getNumber(workspaceConfig, "temperature", DEFAULT_COMPLETION_CONFIG.temperature),
      requestTimeoutMs: getNumber(workspaceConfig, "requestTimeoutMs", DEFAULT_COMPLETION_CONFIG.requestTimeoutMs),
      maxCompletionLines: isManual
        ? getNumber(workspaceConfig, "manualMaxCompletionLines", DEFAULT_COMPLETION_CONFIG.manualMaxLines)
        : getNumber(workspaceConfig, "maxCompletionLines", DEFAULT_COMPLETION_CONFIG.automaticMaxLines),
      maxRelatedFiles: getNumber(workspaceConfig, "maxRelatedFiles", DEFAULT_COMPLETION_CONFIG.maxRelatedFiles),
      maxRelatedFileBytes: getNumber(workspaceConfig, "maxRelatedFileBytes", DEFAULT_COMPLETION_CONFIG.maxRelatedFileBytes),
      lspTimeoutMs: getNumber(workspaceConfig, "lspTimeoutMs", DEFAULT_COMPLETION_CONFIG.lspTimeoutMs),
      idleTriggerEnabled: getBoolean(workspaceConfig, "idleTriggerEnabled", DEFAULT_COMPLETION_CONFIG.idleTriggerEnabled),
      idleTriggerMs: getNumber(workspaceConfig, "idleTriggerMs", DEFAULT_COMPLETION_CONFIG.idleTriggerMs),
      idleTriggerCooldownMs: getNumber(workspaceConfig, "idleTriggerCooldownMs", DEFAULT_COMPLETION_CONFIG.idleTriggerCooldownMs),
      sendThinkingDisabled: getBoolean(workspaceConfig, "sendThinkingDisabled", DEFAULT_COMPLETION_CONFIG.sendThinkingDisabled)
    });
  }
}

function getNumber(config, key, fallback) {
  const value = config && typeof config.get === "function" ? config.get(key) : undefined;
  return Number.isFinite(value) ? value : fallback;
}

function getBoolean(config, key, fallback) {
  const value = config && typeof config.get === "function" ? config.get(key) : undefined;
  return typeof value === "boolean" ? value : fallback;
}

module.exports = {
  CompletionConfig,
  DEFAULT_COMPLETION_CONFIG
};
