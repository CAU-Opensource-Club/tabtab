const { DiagnosticsCache } = require("./diagnosticsCache");
const { FimContextBuilder, DEFAULT_LIMITS } = require("./fimContextBuilder");
const { IncludeAssist } = require("./includeAssist");
const { LocalHeaderIndex } = require("./localHeaderIndex");
const { ProjectProfileCache } = require("./projectProfileCache");

class WorkspaceContextCache {
  constructor({ vscode, context, output, projectProfileService } = {}) {
    this.vscode = vscode;
    this.context = context;
    this.output = output;
    this.projectProfileCache = new ProjectProfileCache({ vscode, projectProfileService });
    this.diagnosticsCache = new DiagnosticsCache({ vscode });
    this.includeAssist = new IncludeAssist({ vscode });
    this.localHeaderIndex = new LocalHeaderIndex({ vscode, output });
    this.fimContextBuilder = new FimContextBuilder();
    this.disposables = [];
  }

  async initialize() {
    this.projectProfileCache.initialize(this.context);
    this.diagnosticsCache.initialize(this.context);

    if (this.isContextCacheEnabled() && this.isLocalHeaderIndexEnabled()) {
      await this.localHeaderIndex.initialize(this.context);
    }

    const workspace = this.vscode && this.vscode.workspace;
    if (workspace && typeof workspace.onDidChangeConfiguration === "function") {
      this.disposables.push(
        workspace.onDidChangeConfiguration((event) => {
          if (
            event.affectsConfiguration("tabtab.localHeaderIndex.enabled")
            || event.affectsConfiguration("tabtab.localHeaderIndex.excludeGlobs")
          ) {
            this.refreshLocalHeaderIndex("configuration changed").catch(() => {});
          }
        })
      );
    }

    if (this.context && Array.isArray(this.context.subscriptions)) {
      this.context.subscriptions.push(this);
    }
  }

  dispose() {
    for (const disposable of this.disposables.splice(0)) {
      if (disposable && typeof disposable.dispose === "function") {
        disposable.dispose();
      }
    }
    this.projectProfileCache.dispose();
    this.diagnosticsCache.dispose();
    this.localHeaderIndex.dispose();
  }

  async refreshProjectProfile(reason) {
    await this.projectProfileCache.refresh(reason);
  }

  async refreshLocalHeaderIndex(reason) {
    if (!this.isContextCacheEnabled() || !this.isLocalHeaderIndexEnabled()) {
      this.localHeaderIndex.dispose();
      return;
    }

    const wasInitialized = this.localHeaderIndex.initialized === true;
    await this.localHeaderIndex.initialize(this.context);
    if (wasInitialized) {
      await this.localHeaderIndex.refreshAll(reason);
    }
  }

  async buildSnapshot(document, position, token) {
    const empty = makeEmptySnapshot();
    if (isCancellationRequested(token) || !this.isContextCacheEnabled()) {
      return empty;
    }

    try {
      const diagnostics = this.diagnosticsCache.getForDocument(document);
      const nearDiagnostics = this.diagnosticsCache.getNearPosition(document, position, 20, 20);
      const includeRegion = this.includeAssist.isCursorInIncludeRegion(document, position);
      const projectProfile = this.isProjectProfileEnabled()
        ? this.projectProfileCache.getForDocument(document)
        : "";

      if (isCancellationRequested(token)) {
        return empty;
      }

      const includeAssistEnabled = this.isIncludeAssistEnabled();
      const missingStandardIncludes = includeAssistEnabled && this.isStandardIncludeAssistEnabled()
        ? this.includeAssist.inferMissingStandardIncludes({
          document,
          diagnostics,
          position
        }).slice(0, 5)
        : [];
      const missingProjectIncludes = includeAssistEnabled && this.isProjectHeaderAssistEnabled()
        ? this.includeAssist.inferMissingProjectIncludes({
          document,
          diagnostics,
          position,
          localHeaderIndex: this.localHeaderIndex
        }).slice(0, 3)
        : [];
      const includeCompletionMode = includeAssistEnabled
        ? this.includeAssist.getIncludeCompletionMode({
          document,
          position,
          missingStandardIncludes,
          missingProjectIncludes
        })
        : makeEmptyIncludeCompletionMode();
      const standardHeaderCandidates = includeAssistEnabled
        ? this.getStandardHeaderCandidates(includeCompletionMode)
        : [];
      const localHeaderCandidates = includeAssistEnabled && this.isProjectHeaderAssistEnabled()
        ? this.getLocalHeaderCandidates(includeCompletionMode)
        : [];
      const includeCompletion = includeAssistEnabled
        ? this.includeAssist.buildPreferredIncludeCompletion({
          document,
          position,
          mode: includeCompletionMode,
          missingStandardIncludes,
          missingProjectIncludes,
          standardHeaderCandidates,
          localHeaderCandidates
        })
        : undefined;

      if (isCancellationRequested(token)) {
        return empty;
      }

      const snapshot = {
        projectProfile,
        diagnosticsContext: nearDiagnostics.slice(0, 8),
        missingStandardIncludes,
        missingProjectIncludes,
        includeRegion,
        includeCompletionMode,
        standardHeaderCandidates,
        localHeaderCandidates,
        includeCompletion,
        promptSections: []
      };
      snapshot.promptSections = this.fimContextBuilder.buildPromptSections(snapshot, {
        maxInjectedChars: this.getMaxInjectedChars()
      });
      return snapshot;
    } catch (error) {
      this.log(`Workspace context cache snapshot failed: ${error.message || String(error)}`);
      return empty;
    }
  }

  isContextCacheEnabled() {
    return this.getBooleanConfig("contextCache.enabled", true);
  }

  isProjectProfileEnabled() {
    return this.getBooleanConfig("projectProfile.enabled", true);
  }

  isIncludeAssistEnabled() {
    return this.getBooleanConfig("includeAssist.enabled", true);
  }

  isStandardIncludeAssistEnabled() {
    return this.getBooleanConfig("includeAssist.standardLibrary.enabled", true);
  }

  isProjectHeaderAssistEnabled() {
    return this.getBooleanConfig("includeAssist.projectHeaders.enabled", true);
  }

  isLocalHeaderIndexEnabled() {
    return this.getBooleanConfig("localHeaderIndex.enabled", true);
  }

  isIncludeCompletionPosition(document, position) {
    return this.isContextCacheEnabled()
      && this.isIncludeAssistEnabled()
      && this.includeAssist.isCursorInIncludeRegion(document, position);
  }

  getStandardHeaderCandidates(includeCompletionMode) {
    const directive = includeCompletionMode && includeCompletionMode.includeDirective;
    if (!directive || directive.delimiter !== "<") {
      return [];
    }

    return this.includeAssist.getStandardHeaderPrefixCandidates(directive.prefix).slice(0, 8);
  }

  getLocalHeaderCandidates(includeCompletionMode) {
    const directive = includeCompletionMode && includeCompletionMode.includeDirective;
    if (
      !directive
      || directive.delimiter !== "\""
      || !this.localHeaderIndex
      || typeof this.localHeaderIndex.lookupIncludePrefix !== "function"
    ) {
      return [];
    }

    return this.localHeaderIndex.lookupIncludePrefix(directive.prefix).slice(0, 8);
  }

  getMaxInjectedChars() {
    return Math.max(200, Math.min(8000, this.getNumberConfig("contextCache.maxInjectedChars", DEFAULT_LIMITS.maxInjectedChars)));
  }

  getBooleanConfig(key, fallback) {
    const config = this.getWorkspaceConfiguration();
    const value = config && typeof config.get === "function" ? config.get(key) : undefined;
    return typeof value === "boolean" ? value : fallback;
  }

  getNumberConfig(key, fallback) {
    const config = this.getWorkspaceConfiguration();
    const value = config && typeof config.get === "function" ? config.get(key) : undefined;
    return Number.isFinite(value) ? value : fallback;
  }

  getWorkspaceConfiguration() {
    const workspace = this.vscode && this.vscode.workspace;
    return workspace && typeof workspace.getConfiguration === "function"
      ? workspace.getConfiguration("tabtab")
      : undefined;
  }

  log(message) {
    if (this.output && typeof this.output.appendLine === "function") {
      this.output.appendLine(message);
    }
  }
}

function makeEmptySnapshot() {
  return {
    projectProfile: "",
    diagnosticsContext: [],
    missingStandardIncludes: [],
    missingProjectIncludes: [],
    includeRegion: false,
    includeCompletionMode: makeEmptyIncludeCompletionMode(),
    standardHeaderCandidates: [],
    localHeaderCandidates: [],
    includeCompletion: undefined,
    promptSections: []
  };
}

function makeEmptyIncludeCompletionMode() {
  return {
    cursorInIncludeRegion: false,
    cursorInsideIncludeDirective: false,
    cursorOnBlankLineInIncludeRegion: false,
    missingIncludeDiagnosticAfterCursor: false,
    hasMissingIncludeHints: false,
    includeDirective: undefined
  };
}

function isCancellationRequested(token) {
  return Boolean(token && token.isCancellationRequested);
}

module.exports = {
  WorkspaceContextCache,
  makeEmptySnapshot
};
