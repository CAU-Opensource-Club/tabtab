const vscode = require("vscode");

const { CONFIG_FILE_NAME } = require("./src/constants");
const { getProviderLabel } = require("./src/api/providerFormats");
const { testApiConnection } = require("./src/api/apiTester");
const { InlineCompletionProvider } = require("./src/completion/inlineCompletionProvider");
const { WorkspaceContextCache } = require("./src/context/workspaceContextCache");
const { ProjectProfileService } = require("./src/projectProfile/projectProfileService");
const { ConfigStore } = require("./src/settings/configStore");
const { TabTabSettingsViewProvider } = require("./src/settings/settingsViewProvider");

async function activate(context) {
  const output = vscode.window.createOutputChannel("TabTab");
  const configStore = new ConfigStore({ vscode, context, output });
  const initialConfig = await configStore.read();

  const projectProfileService = new ProjectProfileService({
    vscode,
    context,
    output,
    projectProfileConfig: initialConfig.projectProfile,
    writeProjectProfileConfig: async (projectProfileConfig) => {
      const config = await configStore.write({
        projectProfile: projectProfileConfig
      });
      return config.projectProfile;
    }
  });
  const workspaceContextCache = new WorkspaceContextCache({
    vscode,
    context,
    output,
    projectProfileService
  });
  const provider = new InlineCompletionProvider({
    vscode,
    context,
    output,
    readRuntimeConfig: () => configStore.read(),
    workspaceContextCache
  });

  const clearApiKey = async () => {
    await configStore.clearApiKey();
    vscode.window.showInformationMessage(`TabTab API key cleared from ${CONFIG_FILE_NAME}.`);
  };
  const setApiKey = async () => {
    const apiKey = await vscode.window.showInputBox({
      prompt: "Enter your API key",
      password: true,
      ignoreFocusOut: true
    });

    if (!apiKey || !apiKey.trim()) {
      return;
    }

    await configStore.saveApiKey(apiKey);
    vscode.window.showInformationMessage(`TabTab API key saved to ${CONFIG_FILE_NAME}.`);
  };
  const testApi = () => testApiConnection({ vscode, output, configStore });

  const settingsProvider = new TabTabSettingsViewProvider({
    vscode,
    context,
    configStore,
    projectProfileService,
    clearApiKey,
    testApiConnection: testApi
  });
  const documentSelector = [
    { scheme: "file" },
    { scheme: "untitled" }
  ];

  context.subscriptions.push(
    output,
    vscode.languages.registerInlineCompletionItemProvider(documentSelector, provider),
    vscode.window.registerWebviewViewProvider(TabTabSettingsViewProvider.viewType, settingsProvider),
    vscode.commands.registerCommand("tabtab.setApiKey", async () => {
      await setApiKey();
      await settingsProvider.refresh();
    }),
    vscode.commands.registerCommand("tabtab.clearApiKey", async () => {
      await clearApiKey();
      await settingsProvider.refresh();
    }),
    vscode.commands.registerCommand("tabtab.testApi", async () => {
      await testApi();
    }),
    vscode.commands.registerCommand("tabtab.projectProfile.detect", async () => {
      await projectProfileService.detectActiveWorkspace({ force: true, showSuccess: true });
    }),
    vscode.commands.registerCommand("tabtab.projectProfile.edit", async () => {
      await projectProfileService.editActiveProfile();
    }),
    vscode.commands.registerCommand("tabtab.projectProfile.clear", async () => {
      await projectProfileService.clearActiveWorkspaceCache();
    })
  );

  projectProfileService.start();
  workspaceContextCache.initialize().catch((error) => {
    output.appendLine(`Workspace context cache initialization failed: ${error.message || String(error)}`);
  });
  output.appendLine(`TabTab activated. provider=${getProviderLabel(initialConfig.provider)} baseUrl=${initialConfig.baseUrl} model=${initialConfig.model} apiKey=${initialConfig.apiKey ? "set" : "missing"}`);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
