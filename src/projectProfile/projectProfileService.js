const crypto = require("crypto");
const path = require("path");

const {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_CHARS,
  sanitizeProfile,
  shortenProfile,
  normalizeProjectProfileConfig
} = require("./profileConfig");
const {
  listGitFiles,
  listFindFiles,
  listTreeFiles,
  getGitHead,
  applyListLimits,
  isExcludedPath,
  normalizeRelativePath,
  comparePaths
} = require("./projectStructure");
const {
  collectManifestInfo,
  readPackageJson,
  detectProjectProfileFromRules
} = require("./profileRules");

const CACHE_KEY_PREFIX = "tabtab.projectProfile.cache:";
const COMMAND_EDIT = "tabtab.projectProfile.edit";
const STATUS_PROFILE_MAX_CHARS = 60;
const PROJECT_PROFILE_DETECTOR_VERSION = 4;

class ProjectProfileService {
  constructor({ vscode, context, output, projectProfileConfig, writeProjectProfileConfig }) {
    this.vscode = vscode;
    this.context = context;
    this.output = output;
    this.projectProfileConfig = normalizeProjectProfileConfig(projectProfileConfig);
    this.writeProjectProfileConfig = writeProjectProfileConfig;
    this.memoryCache = new Map();
    this.pendingDetections = new Map();
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBarItem.command = COMMAND_EDIT;

    context.subscriptions.push(
      this.statusBarItem,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.refreshStatusBar();
        this.detectForDocumentSoon(editor && editor.document);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        this.handleConfigurationChange(event);
      })
    );
  }

  start() {
    this.refreshStatusBar();
    this.detectActiveWorkspaceSoon();
  }

  getProjectProfileConfig() {
    return { ...this.projectProfileConfig };
  }

  async updateProjectProfileConfig(nextConfig, { detect = false, force = false } = {}) {
    const config = normalizeProjectProfileConfig({
      ...this.projectProfileConfig,
      ...nextConfig
    });

    this.projectProfileConfig = config;

    if (typeof this.writeProjectProfileConfig === "function") {
      const writtenConfig = await this.writeProjectProfileConfig(config);
      this.projectProfileConfig = normalizeProjectProfileConfig(writtenConfig || config);
    }

    this.refreshStatusBar();
    if (detect && this.isEnabled() && !this.getManualProfile()) {
      await this.detectActiveWorkspace({ force, showSuccess: false });
    }

    return this.getProjectProfileConfig();
  }

  getPromptProfile(document) {
    if (!this.isEnabled()) {
      return "";
    }

    const manualProfile = this.getManualProfile();
    if (manualProfile) {
      return manualProfile;
    }

    const workspaceFolder = this.getWorkspaceFolderForDocument(document);
    if (!workspaceFolder) {
      return "";
    }

    const entry = this.getCachedEntry(workspaceFolder);
    if (entry) {
      return entry.profile ? sanitizeProfile(entry.profile) : "";
    }

    this.detectWorkspaceSoon(workspaceFolder);
    return "";
  }

  async detectActiveWorkspace({ force = false, showSuccess = false } = {}) {
    const workspaceFolder = this.getActiveWorkspaceFolder();
    if (!workspaceFolder) {
      this.log("Project profile detection skipped: active editor is not inside a workspace folder.");
      this.refreshStatusBar();
      return undefined;
    }

    try {
      const entry = await this.detectWorkspace(workspaceFolder, { force });
      this.refreshStatusBar();

      if (showSuccess) {
        const profile = entry && entry.profile ? shortenProfile(entry.profile, STATUS_PROFILE_MAX_CHARS) : "not detected";
        this.vscode.window.showInformationMessage(`TabTab project profile: ${profile}`);
      }

      return entry;
    } catch (error) {
      this.log(`Project profile detection failed: ${error.message || String(error)}`);
      this.refreshStatusBar();
      return undefined;
    }
  }

  async editActiveProfile() {
    const current = this.getManualProfile()
      || this.getDisplayProfile(this.getActiveDocument())
      || "";
    const value = await this.vscode.window.showInputBox({
      prompt: "Project profile. Leave empty to clear manual override and use auto detection.",
      value: current,
      ignoreFocusOut: true
    });

    if (value === undefined) {
      return;
    }

    const manualProfile = sanitizeProfile(value);
    await this.updateProjectProfileConfig({ manualProfile }, { detect: !manualProfile });

    this.refreshStatusBar();
  }

  async clearActiveWorkspaceCache() {
    const workspaceFolder = this.getActiveWorkspaceFolder();
    if (!workspaceFolder) {
      this.log("Project profile cache clear skipped: active editor is not inside a workspace folder.");
      this.refreshStatusBar();
      return;
    }

    const root = getWorkspaceRoot(workspaceFolder);
    this.memoryCache.delete(root);
    this.pendingDetections.delete(`${root}:cached`);
    this.pendingDetections.delete(`${root}:force`);
    await this.context.workspaceState.update(getCacheKey(root), undefined);
    this.refreshStatusBar();
    this.vscode.window.showInformationMessage("TabTab project profile cache cleared.");
  }

  refreshStatusBar() {
    if (!this.getBooleanConfig("projectProfile.showInStatusBar", true)) {
      this.statusBarItem.hide();
      return;
    }

    if (!this.isEnabled()) {
      this.statusBarItem.text = "TabTab: Profile disabled";
      this.statusBarItem.tooltip = "Project profile detection is disabled.";
      this.statusBarItem.show();
      return;
    }

    const manualProfile = this.getManualProfile();
    if (manualProfile) {
      this.statusBarItem.text = `TabTab: ${shortenProfile(manualProfile, STATUS_PROFILE_MAX_CHARS)}`;
      this.statusBarItem.tooltip = `Manual project profile: ${manualProfile}`;
      this.statusBarItem.show();
      return;
    }

    const document = this.getActiveDocument();
    const profile = this.getDisplayProfile(document);
    if (profile) {
      this.statusBarItem.text = `TabTab: ${shortenProfile(profile, STATUS_PROFILE_MAX_CHARS)}`;
      this.statusBarItem.tooltip = profile;
      this.statusBarItem.show();
      return;
    }

    const workspaceFolder = this.getWorkspaceFolderForDocument(document);
    const cachedEntry = workspaceFolder ? this.getCachedEntry(workspaceFolder) : undefined;
    if (cachedEntry) {
      this.statusBarItem.text = "TabTab: Profile unavailable";
      this.statusBarItem.tooltip = "No project profile was detected for the active workspace.";
      this.statusBarItem.show();
      return;
    }

    this.statusBarItem.text = "TabTab: Profile pending";
    this.statusBarItem.tooltip = "Project profile has not been detected for the active workspace.";
    this.statusBarItem.show();
  }

  handleConfigurationChange(event) {
    if (
      !event.affectsConfiguration("tabtab.projectProfile.enabled")
      && !event.affectsConfiguration("tabtab.projectProfile.manualProfile")
      && !event.affectsConfiguration("tabtab.projectProfile.showInStatusBar")
      && !event.affectsConfiguration("tabtab.projectProfile.maxFiles")
      && !event.affectsConfiguration("tabtab.projectProfile.maxChars")
    ) {
      return;
    }

    this.refreshStatusBar();
    if (this.isEnabled() && !this.getManualProfile()) {
      const force = event.affectsConfiguration("tabtab.projectProfile.maxFiles")
        || event.affectsConfiguration("tabtab.projectProfile.maxChars");
      this.detectActiveWorkspaceSoon({ force });
    }
  }

  detectActiveWorkspaceSoon({ force = false } = {}) {
    if (!this.isEnabled() || this.getManualProfile()) {
      return;
    }

    const workspaceFolder = this.getActiveWorkspaceFolder();
    if (workspaceFolder) {
      this.detectWorkspaceSoon(workspaceFolder, { force });
    }
  }

  detectForDocumentSoon(document, { force = false } = {}) {
    if (!this.isEnabled() || this.getManualProfile()) {
      return;
    }

    const workspaceFolder = this.getWorkspaceFolderForDocument(document);
    if (workspaceFolder) {
      this.detectWorkspaceSoon(workspaceFolder, { force });
    }
  }

  detectWorkspaceSoon(workspaceFolder, { force = false } = {}) {
    this.detectWorkspace(workspaceFolder, { force })
      .then(() => this.refreshStatusBar())
      .catch((error) => {
        this.log(`Project profile detection failed: ${error.message || String(error)}`);
        this.refreshStatusBar();
      });
  }

  async detectWorkspace(workspaceFolder, { force = false } = {}) {
    const root = getWorkspaceRoot(workspaceFolder);
    if (!root) {
      return undefined;
    }

    const pendingKey = `${root}:${force ? "force" : "cached"}`;
    const pending = this.pendingDetections.get(pendingKey);
    if (pending) {
      return pending;
    }

    const promise = this.detectWorkspaceNow(workspaceFolder, { force })
      .finally(() => {
        this.pendingDetections.delete(pendingKey);
      });
    this.pendingDetections.set(pendingKey, promise);
    return promise;
  }

  async detectWorkspaceNow(workspaceFolder, { force }) {
    const root = getWorkspaceRoot(workspaceFolder);
    const limits = this.getDetectionLimits();
    const projectStructure = await this.collectProjectStructure(workspaceFolder, limits);
    const manifestInfo = await collectManifestInfo(root, projectStructure.files);
    const packageJson = await readPackageJson(root);
    const gitHead = await getGitHead(root);
    const fingerprint = hashJson({
      detectorVersion: PROJECT_PROFILE_DETECTOR_VERSION,
      gitHead,
      maxChars: limits.maxChars,
      maxFiles: limits.maxFiles,
      manifests: manifestInfo,
      projectStructureHash: hashText(projectStructure.files.join("\n"))
    });
    const cached = this.getCachedEntry(workspaceFolder);

    if (!force && cached && cached.fingerprint === fingerprint) {
      this.memoryCache.set(root, cached);
      return cached;
    }

    const profile = detectProjectProfileFromRules({
      files: projectStructure.files,
      packageJson
    });
    const entry = {
      workspaceRoot: root,
      fingerprint,
      profile,
      detectedAt: Date.now(),
      source: "local-rules"
    };

    this.memoryCache.set(root, entry);
    await this.context.workspaceState.update(getCacheKey(root), entry);
    return entry;
  }

  async collectProjectStructure(workspaceFolder, limits) {
    const root = getWorkspaceRoot(workspaceFolder);
    let files = [];

    try {
      files = await listGitFiles(root, limits);
    } catch (error) {
      try {
        files = await listFindFiles(root, limits);
      } catch (findError) {
        try {
          files = await listTreeFiles(root, limits);
        } catch (treeError) {
          files = await this.findWorkspaceFiles(workspaceFolder, limits);
        }
      }
    }

    return {
      files: applyListLimits(files, limits)
    };
  }

  async findWorkspaceFiles(workspaceFolder, limits) {
    const exclude = "{**/.git/**,**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/target/**,**/.cache/**,**/.vscode/**,**/coverage/**,**/vendor/**,**/third_party/**,**/__pycache__/**,**/*.lock,**/*.min.js,**/*.map}";
    const uris = await this.vscode.workspace.findFiles(
      new this.vscode.RelativePattern(workspaceFolder, "**/*"),
      exclude,
      limits.maxFiles * 2
    );
    const root = getWorkspaceRoot(workspaceFolder);

    return uris
      .map((uri) => normalizeRelativePath(path.relative(root, uri.fsPath || "")))
      .filter((file) => file && !isExcludedPath(file))
      .sort(comparePaths);
  }

  getDisplayProfile(document) {
    const workspaceFolder = this.getWorkspaceFolderForDocument(document);
    if (!workspaceFolder) {
      return "";
    }

    const entry = this.getCachedEntry(workspaceFolder);
    return entry && entry.profile ? sanitizeProfile(entry.profile) : "";
  }

  getCachedEntry(workspaceFolder) {
    const root = getWorkspaceRoot(workspaceFolder);
    if (!root) {
      return undefined;
    }

    const cached = this.memoryCache.get(root) || this.context.workspaceState.get(getCacheKey(root));
    if (!cached || cached.workspaceRoot !== root || typeof cached.profile !== "string") {
      return undefined;
    }

    return {
      workspaceRoot: root,
      fingerprint: typeof cached.fingerprint === "string" ? cached.fingerprint : "",
      profile: sanitizeProfile(cached.profile),
      detectedAt: Number.isFinite(cached.detectedAt) ? cached.detectedAt : 0,
      source: cached.source === "model" || cached.source === "manual" ? cached.source : "local-rules"
    };
  }

  getActiveWorkspaceFolder() {
    const document = this.getActiveDocument();
    const workspaceFolder = this.getWorkspaceFolderForDocument(document);
    if (workspaceFolder) {
      return workspaceFolder;
    }

    const folders = this.vscode.workspace.workspaceFolders || [];
    return folders[0];
  }

  getWorkspaceFolderForDocument(document) {
    if (!document || !document.uri || !this.vscode.workspace.workspaceFolders) {
      return undefined;
    }

    return this.vscode.workspace.getWorkspaceFolder(document.uri);
  }

  getActiveDocument() {
    const editor = this.vscode.window.activeTextEditor;
    return editor && editor.document ? editor.document : undefined;
  }

  isEnabled() {
    return this.getBooleanConfig("projectProfile.enabled", false);
  }

  getManualProfile() {
    return sanitizeProfile(this.getStringConfig("projectProfile.manualProfile", ""));
  }

  getDetectionLimits() {
    return {
      maxFiles: Math.max(1, Math.floor(this.getNumberConfig("projectProfile.maxFiles", DEFAULT_MAX_FILES))),
      maxChars: Math.max(1, Math.floor(this.getNumberConfig("projectProfile.maxChars", DEFAULT_MAX_CHARS)))
    };
  }

  getBooleanConfig(key, fallback) {
    if (key === "projectProfile.enabled") {
      return this.projectProfileConfig.enabled;
    }

    if (key === "projectProfile.showInStatusBar") {
      return this.projectProfileConfig.showInStatusBar;
    }

    const value = this.vscode.workspace.getConfiguration("tabtab").get(key);
    return typeof value === "boolean" ? value : fallback;
  }

  getNumberConfig(key, fallback) {
    if (key === "projectProfile.maxFiles") {
      return this.projectProfileConfig.maxFiles;
    }

    if (key === "projectProfile.maxChars") {
      return this.projectProfileConfig.maxChars;
    }

    const value = this.vscode.workspace.getConfiguration("tabtab").get(key);
    return Number.isFinite(value) ? value : fallback;
  }

  getStringConfig(key, fallback) {
    if (key === "projectProfile.manualProfile") {
      return this.projectProfileConfig.manualProfile;
    }

    const value = this.vscode.workspace.getConfiguration("tabtab").get(key);
    return typeof value === "string" ? value : fallback;
  }

  log(message) {
    if (this.output && typeof this.output.appendLine === "function") {
      this.output.appendLine(message);
    }
  }
}

function getWorkspaceRoot(workspaceFolder) {
  return workspaceFolder && workspaceFolder.uri && workspaceFolder.uri.fsPath
    ? workspaceFolder.uri.fsPath
    : "";
}

function getCacheKey(workspaceRoot) {
  return `${CACHE_KEY_PREFIX}${workspaceRoot}`;
}

function hashJson(value) {
  return hashText(JSON.stringify(value));
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

module.exports = {
  ProjectProfileService
};
