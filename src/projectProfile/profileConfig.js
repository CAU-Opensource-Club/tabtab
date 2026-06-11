const { sanitizeSingleLine } = require("../shared/textUtils");

const PROFILE_MAX_CHARS = 200;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_PROJECT_PROFILE_CONFIG = {
  enabled: true,
  manualProfile: "",
  showInStatusBar: true,
  maxFiles: DEFAULT_MAX_FILES,
  maxChars: DEFAULT_MAX_CHARS
};

function sanitizeProfile(value) {
  return sanitizeSingleLine(value, PROFILE_MAX_CHARS);
}

function shortenProfile(value, maxLength) {
  const profile = sanitizeProfile(value);
  if (profile.length <= maxLength) {
    return profile;
  }

  return `${profile.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeProjectProfileConfig(config) {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
  const maxFiles = Number.isFinite(source.maxFiles)
    ? source.maxFiles
    : DEFAULT_PROJECT_PROFILE_CONFIG.maxFiles;
  const maxChars = Number.isFinite(source.maxChars)
    ? source.maxChars
    : DEFAULT_PROJECT_PROFILE_CONFIG.maxChars;

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_PROJECT_PROFILE_CONFIG.enabled,
    manualProfile: sanitizeProfile(source.manualProfile),
    showInStatusBar: typeof source.showInStatusBar === "boolean"
      ? source.showInStatusBar
      : DEFAULT_PROJECT_PROFILE_CONFIG.showInStatusBar,
    maxFiles: Math.max(1, Math.floor(maxFiles)),
    maxChars: Math.max(1, Math.floor(maxChars))
  };
}

function isProjectProfileConfig(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.enabled === "boolean"
    && typeof value.manualProfile === "string"
    && typeof value.showInStatusBar === "boolean"
    && Number.isFinite(value.maxFiles)
    && Number.isFinite(value.maxChars);
}

module.exports = {
  PROFILE_MAX_CHARS,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_CHARS,
  DEFAULT_PROJECT_PROFILE_CONFIG,
  sanitizeProfile,
  shortenProfile,
  normalizeProjectProfileConfig,
  isProjectProfileConfig
};
