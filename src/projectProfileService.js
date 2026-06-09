const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CACHE_KEY_PREFIX = "tabtab.projectProfile.cache:";
const COMMAND_EDIT = "tabtab.projectProfile.edit";
const GIT_TIMEOUT_MS = 1500;
const STRUCTURE_COMMAND_TIMEOUT_MS = 1500;
const PROFILE_MAX_CHARS = 200;
const STATUS_PROFILE_MAX_CHARS = 60;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_CHARS = 12000;
const PROJECT_PROFILE_DETECTOR_VERSION = 4;
const DEFAULT_PROJECT_PROFILE_CONFIG = {
  enabled: false,
  manualProfile: "",
  showInStatusBar: true,
  maxFiles: DEFAULT_MAX_FILES,
  maxChars: DEFAULT_MAX_CHARS
};

const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".vscode",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "third_party",
  "vendor"
]);

const COMMON_LOCK_FILES = new Set([
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock"
]);

const EXACT_MANIFEST_PATHS = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "CMakeLists.txt",
  "Makefile",
  "GNUmakefile",
  "makefile",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "requirements.txt",
  "extension.ts",
  "extension.js",
  "src/extension.ts",
  "src/extension.js"
];

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

  getConfigurationTarget() {
    if (this.vscode.workspace.workspaceFolders && this.vscode.workspace.workspaceFolders.length) {
      return this.vscode.ConfigurationTarget.Workspace;
    }

    return this.vscode.ConfigurationTarget.Global;
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

async function listGitFiles(root, limits) {
  return new Promise((resolve, reject) => {
    const files = [];
    let chars = 0;
    let pending = "";
    let finished = false;
    let stderr = "";
    const child = childProcess.spawn("git", ["ls-files", "-z"], {
      cwd: root,
      shell: false
    });
    const timer = setTimeout(() => {
      finish(reject, new Error("git ls-files timed out"));
      child.kill();
    }, GIT_TIMEOUT_MS);

    const finish = (callback, value) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      callback(value);
    };

    const consume = (includeTail) => {
      while (pending && !finished) {
        const index = pending.indexOf("\0");
        if (index < 0) {
          if (includeTail) {
            addGitPath(pending);
            pending = "";
          }
          break;
        }

        addGitPath(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    };

    const addGitPath = (rawPath) => {
      if (finished) {
        return;
      }

      const file = normalizeRelativePath(rawPath);
      if (!file || isExcludedPath(file) || files.length >= limits.maxFiles) {
        return;
      }

      const nextChars = chars + file.length + 1;
      if (nextChars > limits.maxChars) {
        finish(resolve, files);
        child.kill();
        return;
      }

      files.push(file);
      chars = nextChars;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      consume(false);

      if (!finished && files.length >= limits.maxFiles) {
        finish(resolve, files);
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (finished) {
        return;
      }

      consume(true);
      if (code === 0) {
        finish(resolve, files.sort(comparePaths));
      } else {
        finish(reject, new Error(stderr.trim() || `git ls-files exited with ${code}`));
      }
    });
  });
}

async function listFindFiles(root, limits) {
  const pruneArgs = [];
  for (const directory of EXCLUDED_DIRECTORIES) {
    if (pruneArgs.length) {
      pruneArgs.push("-o");
    }
    pruneArgs.push("-name", directory);
  }

  const args = [
    ".",
    "(",
    ...pruneArgs,
    ")",
    "-prune",
    "-o",
    "-type",
    "f",
    "-print"
  ];

  return listLineSeparatedCommandFiles({
    root,
    command: "find",
    args,
    limits,
    timeoutMs: STRUCTURE_COMMAND_TIMEOUT_MS,
    normalizePath: normalizeRelativePath
  });
}

async function listTreeFiles(root, limits) {
  const ignorePattern = [
    ...EXCLUDED_DIRECTORIES,
    "*.lock",
    "*.min.js",
    "*.map"
  ].join("|");

  return listLineSeparatedCommandFiles({
    root,
    command: "tree",
    args: ["-a", "-f", "-i", "-F", "--noreport", "-I", ignorePattern, "."],
    limits,
    timeoutMs: STRUCTURE_COMMAND_TIMEOUT_MS,
    normalizePath: normalizeTreePath
  });
}

async function listLineSeparatedCommandFiles({ root, command, args, limits, timeoutMs, normalizePath }) {
  return new Promise((resolve, reject) => {
    const files = [];
    let chars = 0;
    let pending = "";
    let finished = false;
    let stderr = "";
    const child = childProcess.spawn(command, args, {
      cwd: root,
      shell: false
    });
    const timer = setTimeout(() => {
      finish(reject, new Error(`${command} timed out`));
      child.kill();
    }, timeoutMs);

    const finish = (callback, value) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      callback(value);
    };

    const consume = (includeTail) => {
      while (pending && !finished) {
        const index = pending.indexOf("\n");
        if (index < 0) {
          if (includeTail) {
            addPath(pending);
            pending = "";
          }
          break;
        }

        addPath(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    };

    const addPath = (rawPath) => {
      if (finished) {
        return;
      }

      const file = normalizePath(rawPath.replace(/\r$/, ""));
      if (!file || isExcludedPath(file) || files.length >= limits.maxFiles) {
        return;
      }

      const nextChars = chars + file.length + 1;
      if (nextChars > limits.maxChars) {
        finish(resolve, files);
        child.kill();
        return;
      }

      files.push(file);
      chars = nextChars;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      consume(false);

      if (!finished && files.length >= limits.maxFiles) {
        finish(resolve, files);
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (finished) {
        return;
      }

      consume(true);
      if (code === 0) {
        finish(resolve, files.sort(comparePaths));
      } else {
        finish(reject, new Error(stderr.trim() || `${command} exited with ${code}`));
      }
    });
  });
}

async function getGitHead(root) {
  try {
    return sanitizeControlText(await runGitText(root, ["rev-parse", "HEAD"], GIT_TIMEOUT_MS)).trim();
  } catch (error) {
    return "";
  }
}

async function runGitText(root, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    const child = childProcess.spawn("git", args, {
      cwd: root,
      shell: false
    });
    const timer = setTimeout(() => {
      finish(reject, new Error("git command timed out"));
      child.kill();
    }, timeoutMs);

    const finish = (callback, value) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      callback(value);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, stdout);
      } else {
        finish(reject, new Error(stderr.trim() || `git ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function collectManifestInfo(root, files) {
  const fileSet = new Set(files);
  const manifestPaths = new Set(EXACT_MANIFEST_PATHS);

  for (const file of files) {
    if (isRootConfigMatch(file, "vite.config.") || isRootConfigMatch(file, "next.config.")) {
      manifestPaths.add(file);
    }
  }

  const entries = [];
  for (const relativePath of Array.from(manifestPaths).sort(comparePaths)) {
    const existsInStructure = fileSet.has(relativePath);
    let stat;

    try {
      stat = await fs.promises.stat(path.join(root, relativePath));
    } catch (error) {
      stat = undefined;
    }

    entries.push({
      path: relativePath,
      exists: Boolean(existsInStructure || stat),
      mtimeMs: stat ? Math.trunc(stat.mtimeMs) : 0,
      size: stat ? stat.size : 0
    });
  }

  return entries;
}

async function readPackageJson(root) {
  try {
    const raw = await fs.promises.readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch (error) {
    return undefined;
  }
}

function detectProjectProfileFromRules({ files, packageJson }) {
  const fileSet = new Set(files);
  const hasPackageJson = fileSet.has("package.json") || Boolean(packageJson);
  const language = inferJsLanguage(fileSet, packageJson);

  if (hasPackageJson && isVscodeExtension(fileSet, packageJson)) {
    const purpose = hasFimSignal(fileSet) ? " for FIM inline completion" : "";
    return sanitizeProfile(`${language} VSCode extension${purpose}; prefer VSCode Extension API patterns.`);
  }

  if (hasPackageJson && hasRootPrefix(fileSet, "vite.config.")) {
    return sanitizeProfile(`${language} Vite frontend project; prefer project-local UI and build patterns.`);
  }

  if (hasPackageJson && hasRootPrefix(fileSet, "next.config.")) {
    return sanitizeProfile(`${language} Next.js project; prefer Next.js and project-local React patterns.`);
  }

  if (fileSet.has("pyproject.toml")) {
    return "Python project; prefer project-local package and tooling patterns.";
  }

  if (fileSet.has("Cargo.toml")) {
    return "Rust project; prefer Cargo workspace and idiomatic Rust patterns.";
  }

  if (fileSet.has("go.mod")) {
    return "Go project; prefer module-local packages and idiomatic Go patterns.";
  }

  const domainProfile = inferDomainProfile(fileSet);
  if (domainProfile) {
    return domainProfile;
  }

  if (fileSet.has("CMakeLists.txt")) {
    return "C/C++ CMake project; prefer existing targets and modern C++ patterns.";
  }

  if (hasMakefile(fileSet)) {
    return "C/C++ Makefile project; prefer existing make targets and modern C++ patterns.";
  }

  if (fileSet.has("pom.xml")) {
    return "Maven Java project; prefer existing Maven module and JVM patterns.";
  }

  if (fileSet.has("build.gradle")) {
    return "Gradle JVM project; prefer existing Gradle module and JVM patterns.";
  }

  if (hasPackageJson) {
    return sanitizeProfile(`${language} project; prefer project-local module and tooling patterns.`);
  }

  return "";
}

function inferDomainProfile(fileSet) {
  const hasDataPlane = hasPathPrefix(fileSet, "src/data_plane/")
    || hasPathPrefix(fileSet, "src/dataplane/");
  const hasControlPlane = hasPathPrefix(fileSet, "src/control_plane/")
    || hasPathPrefix(fileSet, "src/controlplane/");
  const hasNetProtocol = hasPathPrefix(fileSet, "src/net/protocol/");
  const hasRouterTables = hasPathPrefix(fileSet, "src/net/service/fib/")
    || hasPathPrefix(fileSet, "src/net/service/fdb/")
    || hasPathPrefix(fileSet, "src/net/service/nat/");
  const hasEbpfXdp = hasPathPrefix(fileSet, "ebpf/")
    || hasPathSubstring(fileSet, "xdp");

  if (
    (hasDataPlane && hasControlPlane && hasNetProtocol)
    || (hasDataPlane && hasRouterTables)
    || (hasEbpfXdp && hasNetProtocol)
  ) {
    return "High-performance C++ router/data-plane project with eBPF/XDP networking; prefer low-latency packet-processing patterns.";
  }

  if (hasNetProtocol && hasRouterTables) {
    return "C++ router/networking project; prefer packet-processing, protocol parsing, and table-management patterns.";
  }

  if (hasEbpfXdp) {
    return "C/C++ eBPF/XDP networking project; prefer low-level packet-processing and kernel/userspace boundary patterns.";
  }

  return "";
}

function isVscodeExtension(fileSet, packageJson) {
  if (packageJson && packageJson.engines && packageJson.engines.vscode) {
    return true;
  }

  if (packageJson && packageJson.contributes && typeof packageJson.contributes === "object") {
    return true;
  }

  if (!packageJson) {
    return false;
  }

  const main = typeof packageJson.main === "string" ? normalizeRelativePath(packageJson.main) : "";
  return Boolean(main && (main === "extension.js" || main === "extension.ts" || main.startsWith("src/extension.")));
}

function inferJsLanguage(fileSet, packageJson) {
  if (
    fileSet.has("tsconfig.json")
    || fileSet.has("extension.ts")
    || fileSet.has("src/extension.ts")
    || hasExtension(fileSet, ".ts")
    || hasExtension(fileSet, ".tsx")
  ) {
    return "TypeScript";
  }

  const devDependencies = packageJson && packageJson.devDependencies;
  if (devDependencies && typeof devDependencies === "object" && devDependencies.typescript) {
    return "TypeScript";
  }

  return "JavaScript";
}

function hasFimSignal(fileSet) {
  for (const file of fileSet) {
    const lower = file.toLowerCase();
    if (lower.includes("fim") || lower.includes("inlinecompletion")) {
      return true;
    }
  }

  return false;
}

function hasMakefile(fileSet) {
  return fileSet.has("Makefile") || fileSet.has("makefile") || fileSet.has("GNUmakefile");
}

function hasExtension(fileSet, extension) {
  for (const file of fileSet) {
    if (file.toLowerCase().endsWith(extension)) {
      return true;
    }
  }

  return false;
}

function hasRootPrefix(fileSet, prefix) {
  for (const file of fileSet) {
    if (isRootConfigMatch(file, prefix)) {
      return true;
    }
  }

  return false;
}

function hasPathPrefix(fileSet, prefix) {
  for (const file of fileSet) {
    if (file.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function hasPathSubstring(fileSet, value) {
  for (const file of fileSet) {
    if (file.includes(value)) {
      return true;
    }
  }

  return false;
}

function isRootConfigMatch(file, prefix) {
  return !file.includes("/") && file.startsWith(prefix);
}

function applyListLimits(files, limits) {
  const result = [];
  let chars = 0;

  for (const rawFile of files) {
    if (result.length >= limits.maxFiles) {
      break;
    }

    const file = normalizeRelativePath(rawFile);
    if (!file || isExcludedPath(file)) {
      continue;
    }

    const nextChars = chars + file.length + 1;
    if (nextChars > limits.maxChars) {
      break;
    }

    result.push(file);
    chars = nextChars;
  }

  return result;
}

function isExcludedPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  if (!normalized) {
    return true;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
    return true;
  }

  const baseName = path.posix.basename(normalized);
  return baseName.endsWith(".lock")
    || baseName.endsWith(".min.js")
    || baseName.endsWith(".map")
    || COMMON_LOCK_FILES.has(baseName);
}

function normalizeRelativePath(value) {
  const cleaned = sanitizeControlText(value)
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .trim();

  if (!cleaned) {
    return "";
  }

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    return "";
  }

  return parts.join("/");
}

function normalizeTreePath(value) {
  const text = sanitizeControlText(value).trim();
  if (!text || text.endsWith("/")) {
    return "";
  }

  return normalizeRelativePath(text.replace(/[*=@|]$/, ""));
}

function sanitizeProfile(value) {
  return sanitizeControlText(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PROFILE_MAX_CHARS);
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

function sanitizeControlText(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ");
}

function shortenProfile(value, maxLength) {
  const profile = sanitizeProfile(value);
  if (profile.length <= maxLength) {
    return profile;
  }

  return `${profile.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
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

function comparePaths(left, right) {
  return left.localeCompare(right);
}

module.exports = {
  ProjectProfileService,
  normalizeProjectProfileConfig
};
