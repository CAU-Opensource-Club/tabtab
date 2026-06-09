const MANIFEST_GLOB = "**/{package.json,pyproject.toml,Cargo.toml,CMakeLists.txt,go.mod,tsconfig.json,compile_commands.json}";

class ProjectProfileCache {
  constructor({ vscode, projectProfileService } = {}) {
    this.vscode = vscode;
    this.projectProfileService = projectProfileService;
    this.disposables = [];
    this.refreshTimer = undefined;
  }

  initialize(context) {
    const workspace = this.vscode && this.vscode.workspace;
    if (!workspace) {
      return;
    }

    if (typeof workspace.createFileSystemWatcher === "function") {
      const watcher = workspace.createFileSystemWatcher(MANIFEST_GLOB);
      watcher.onDidCreate(() => this.scheduleRefresh("manifest created"));
      watcher.onDidChange(() => this.scheduleRefresh("manifest changed"));
      watcher.onDidDelete(() => this.scheduleRefresh("manifest deleted"));
      this.disposables.push(watcher);
    }

    if (typeof workspace.onDidChangeWorkspaceFolders === "function") {
      this.disposables.push(
        workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh("workspace folders changed"))
      );
    }

    if (context && Array.isArray(context.subscriptions)) {
      context.subscriptions.push(this);
    }
  }

  dispose() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    for (const disposable of this.disposables.splice(0)) {
      if (disposable && typeof disposable.dispose === "function") {
        disposable.dispose();
      }
    }
  }

  async refresh(reason) {
    if (
      this.projectProfileService
      && typeof this.projectProfileService.detectActiveWorkspace === "function"
    ) {
      await this.projectProfileService.detectActiveWorkspace({
        force: true,
        showSuccess: false,
        reason
      });
    }
  }

  getForDocument(document) {
    if (
      this.projectProfileService
      && typeof this.projectProfileService.isEnabled === "function"
      && !this.projectProfileService.isEnabled()
    ) {
      return "";
    }

    if (
      this.projectProfileService
      && typeof this.projectProfileService.getManualProfile === "function"
    ) {
      const manualProfile = sanitizeProjectProfile(this.projectProfileService.getManualProfile());
      if (manualProfile) {
        return manualProfile;
      }
    }

    if (
      this.projectProfileService
      && typeof this.projectProfileService.getWorkspaceFolderForDocument === "function"
      && typeof this.projectProfileService.getCachedEntry === "function"
    ) {
      const workspaceFolder = this.projectProfileService.getWorkspaceFolderForDocument(document);
      const entry = workspaceFolder ? this.projectProfileService.getCachedEntry(workspaceFolder) : undefined;
      return sanitizeProjectProfile(entry && entry.profile);
    }

    return "";
  }

  scheduleRefresh(reason) {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh(reason).catch(() => {});
    }, 800);
  }
}

function sanitizeProjectProfile(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

module.exports = {
  ProjectProfileCache,
  sanitizeProjectProfile
};
