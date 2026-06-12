const { FimClient } = require("../api/fimClient");
const { createControllerToken, delay, withTimeout } = require("../shared/asyncUtils");
const { CompletionConfig } = require("./completionConfig");
const { CompletionPostProcessor } = require("./completionPostProcessor");
const { looksLikeCompleteStatementEnd } = require("./completionContextRules");
const { ContextBuilder } = require("./contextBuilder");
const { RelatedFileSelector } = require("./relatedFileSelector");

const INLINE_SUGGEST_TRIGGER_COMMAND = "editor.action.inlineSuggest.trigger";
const IDLE_TRIGGER_PENDING_MS = 2000;

class InlineCompletionProvider {
  constructor(options) {
    this.vscode = options.vscode;
    this.context = options.context;
    this.output = options.output;
    this.readRuntimeConfig = options.readRuntimeConfig;
    this.workspaceContextCache = options.workspaceContextCache;
    this.lastError = "";
    this.activeRequest = undefined;
    this.inlineSuggestTriggerTimer = undefined;
    this.idleTriggerTimer = undefined;
    this.idleTriggerSnapshot = undefined;
    this.pendingIdleTriggerSnapshot = undefined;
    this.lastIdleTriggerAt = 0;
    this.relatedFileSelector = new RelatedFileSelector({
      vscode: this.vscode,
      context: this.context,
      output: this.output
    });
    this.contextBuilder = new ContextBuilder({
      relatedFileSelector: this.relatedFileSelector
    });
    this.fimClient = new FimClient({
      output: this.output
    });
    this.postProcessor = new CompletionPostProcessor();

    if (this.context && this.context.subscriptions) {
      this.context.subscriptions.push(
        this.vscode.workspace.onDidChangeTextDocument((event) => {
          this.relatedFileSelector.recordDocument(event.document);
          if (
            this.activeRequest
            && event.document
            && this.activeRequest.documentUri === event.document.uri.toString()
          ) {
            if (this.isRemoteRequestInFlight(this.activeRequest)) {
              this.activeRequest.retriggerAfterFinish = true;
            } else {
              this.cancelActiveRequest();
            }
          }

          const editor = this.vscode.window.activeTextEditor;
          if (editor && event.document && editor.document.uri.toString() === event.document.uri.toString()) {
            this.scheduleIdleTriggerForActiveEditor();
          }
        })
      );

      this.context.subscriptions.push(
        this.vscode.window.onDidChangeTextEditorSelection((event) => {
          if (event.textEditor === this.vscode.window.activeTextEditor) {
            this.scheduleIdleTriggerForActiveEditor();
          }
        }),
        this.vscode.window.onDidChangeActiveTextEditor(() => {
          this.scheduleIdleTriggerForActiveEditor();
        })
      );

      this.context.subscriptions.push({
        dispose: () => {
          if (this.inlineSuggestTriggerTimer) {
            clearTimeout(this.inlineSuggestTriggerTimer);
            this.inlineSuggestTriggerTimer = undefined;
          }
          this.clearIdleTrigger();
          this.pendingIdleTriggerSnapshot = undefined;
        }
      });

      this.scheduleIdleTriggerForActiveEditor();
    }
  }

  async provideInlineCompletionItems(document, position, inlineContext, token) {
    const idleTriggered = this.takeMatchingIdleTriggerSnapshot(document, position);
    const effectiveInlineContext = idleTriggered
      ? { triggerKind: this.vscode.InlineCompletionTriggerKind.Automatic }
      : inlineContext;
    const workspaceConfig = this.vscode.workspace.getConfiguration("tabtab");
    const config = CompletionConfig.fromWorkspace(workspaceConfig, effectiveInlineContext, this.vscode);
    config.skipDebounce = idleTriggered;

    if (!this.canProvide(document, position, effectiveInlineContext, token, config)) {
      return undefined;
    }

    const documentVersion = document.version;
    const requestKey = makeRequestKey(document, position, documentVersion, config);

    if (this.activeRequest && this.activeRequest.key === requestKey) {
      const sharedResult = await this.activeRequest.promise;
      return token.isCancellationRequested ? undefined : sharedResult;
    }

    if (this.activeRequest && this.shouldWaitForActiveRequest(this.activeRequest, config)) {
      this.activeRequest.retriggerAfterFinish = true;
      return undefined;
    }

    if (this.activeRequest) {
      this.cancelActiveRequest();
    }

    const controller = new AbortController();
    const request = {
      key: requestKey,
      documentUri: document.uri.toString(),
      documentVersion,
      positionLine: position.line,
      positionCharacter: position.character,
      controller,
      promise: undefined,
      phase: "waiting",
      retriggerAfterFinish: false
    };
    this.activeRequest = request;
    request.promise = this.runCompletionRequest({
      document,
      position,
      config,
      documentVersion,
      request,
      controller
    });

    const result = await request.promise;
    return token.isCancellationRequested ? undefined : result;
  }

  async runCompletionRequest({ document, position, config, documentVersion, request, controller }) {
    const requestToken = createControllerToken(controller);
    try {
      if (!config.isManual && !config.skipDebounce) {
        await delay(config.debounceMs, requestToken, controller.signal);
      }

      if (this.isStale(document, documentVersion, request)) {
        return undefined;
      }

      request.phase = "building";
      const workspaceSnapshot = this.workspaceContextCache
        ? await this.workspaceContextCache.buildSnapshot(document, position, requestToken)
        : { promptSections: [] };

      const includeCompletion = workspaceSnapshot && workspaceSnapshot.includeCompletion
        ? workspaceSnapshot.includeCompletion
        : undefined;
      if (includeCompletion && includeCompletion.text && !this.isStale(document, documentVersion, request)) {
        return this.makeInlineCompletionResult(includeCompletion.text, position, includeCompletion.replaceRange);
      }

      const runtimeConfig = await this.readRuntimeConfig();
      if (!runtimeConfig) {
        this.logError("Missing API key. Set apiKey in tabtab.config.json.");
        return undefined;
      }

      if (runtimeConfig.fimEnabled === false) {
        return undefined;
      }

      if (!runtimeConfig.apiKey) {
        this.logError("Missing API key. Set apiKey in tabtab.config.json.");
        return undefined;
      }

      const fimContext = await this.contextBuilder.build({
        document,
        position,
        token: requestToken,
        config
      });
      fimContext.projectProfile = workspaceSnapshot && workspaceSnapshot.projectProfile
        ? workspaceSnapshot.projectProfile
        : "";
      fimContext.cachedContextSections = workspaceSnapshot && Array.isArray(workspaceSnapshot.promptSections)
        ? workspaceSnapshot.promptSections
        : [];

      if (this.isStale(document, documentVersion, request)) {
        return undefined;
      }

      request.phase = "requesting";
      const rawCompletion = await withTimeout(
        this.fimClient.complete({
          runtimeConfig,
          context: fimContext,
          config,
          token: requestToken,
          signal: controller.signal
        }),
        config.requestTimeoutMs,
        controller
      );

      if (this.isStale(document, documentVersion, request)) {
        return undefined;
      }

      request.phase = "processing";
      const completion = this.postProcessor.process({
        raw: rawCompletion,
        context: fimContext,
        config
      });

      if (!completion || this.isStale(document, documentVersion, request)) {
        return undefined;
      }

      return this.makeInlineCompletionResult(completion, position);
    } catch (error) {
      if (error && (error.name === "AbortError" || error.message === "cancelled")) {
        return undefined;
      }

      this.logError(`Inline completion failed: ${error.message || String(error)}`);
      return undefined;
    } finally {
      if (this.activeRequest === request) {
        const shouldRetrigger = request.retriggerAfterFinish && !request.controller.signal.aborted;
        this.activeRequest = undefined;
        if (shouldRetrigger) {
          this.scheduleInlineSuggestTrigger();
        }
      }
    }
  }

  canProvide(document, position, inlineContext, token, config) {
    if (!config.enabled || token.isCancellationRequested) {
      return false;
    }

    const editor = this.vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
      return false;
    }

    if (!editor.selection.isEmpty) {
      return false;
    }

    if (position.line !== editor.selection.active.line || position.character !== editor.selection.active.character) {
      return false;
    }

    if (inlineContext.triggerKind === this.vscode.InlineCompletionTriggerKind.Automatic) {
      const line = document.lineAt(position.line).text;
      const linePrefix = line.slice(0, position.character);
      const lineSuffix = line.slice(position.character);
      if (!linePrefix.trim()) {
        return this.isIncludeCompletionPosition(document, position);
      }

      if (looksLikeCompleteStatementEnd(linePrefix, lineSuffix)) {
        return false;
      }
    }

    return true;
  }

  makeInlineCompletionResult(completion, position, replaceRange) {
    const range = replaceRange
      ? new this.vscode.Range(
        replaceRange.start.line,
        replaceRange.start.character,
        replaceRange.end.line,
        replaceRange.end.character
      )
      : new this.vscode.Range(position, position);

    return {
      items: [
        new this.vscode.InlineCompletionItem(
          completion,
          range
        )
      ]
    };
  }

  isIncludeCompletionPosition(document, position) {
    return Boolean(
      this.workspaceContextCache
      && typeof this.workspaceContextCache.isIncludeCompletionPosition === "function"
      && this.workspaceContextCache.isIncludeCompletionPosition(document, position)
    );
  }

  isStale(document, documentVersion, request) {
    return request.controller.signal.aborted
      || this.activeRequest !== request
      || document.version !== documentVersion
      || this.hasCursorMoved(document, request);
  }

  hasCursorMoved(document, request) {
    const editor = this.vscode.window.activeTextEditor;
    return !editor
      || editor.document.uri.toString() !== document.uri.toString()
      || !editor.selection.isEmpty
      || editor.selection.active.line !== request.positionLine
      || editor.selection.active.character !== request.positionCharacter;
  }

  shouldWaitForActiveRequest(request, config) {
    return this.isRemoteRequestInFlight(request) && !config.isManual;
  }

  isRemoteRequestInFlight(request) {
    return request && request.phase === "requesting";
  }

  cancelActiveRequest() {
    if (this.activeRequest) {
      this.activeRequest.controller.abort();
      this.activeRequest = undefined;
    }
  }

  scheduleInlineSuggestTrigger() {
    if (this.inlineSuggestTriggerTimer) {
      return;
    }

    this.inlineSuggestTriggerTimer = setTimeout(() => {
      this.inlineSuggestTriggerTimer = undefined;
      this.executeInlineSuggestTrigger("Inline suggestion retrigger failed");
    }, 0);
  }

  scheduleIdleTriggerForActiveEditor() {
    const editor = this.vscode.window.activeTextEditor;
    const config = this.readAutomaticConfig();
    if (
      !config.enabled
      || !config.idleTriggerEnabled
      || config.idleTriggerMs <= 0
      || !this.canIdleTrigger(editor, config)
    ) {
      this.clearIdleTrigger();
      return;
    }

    const now = Date.now();
    const cooldownRemaining = Math.max(0, config.idleTriggerCooldownMs - (now - this.lastIdleTriggerAt));
    const delayMs = Math.max(config.idleTriggerMs, cooldownRemaining);
    this.idleTriggerSnapshot = makeEditorSnapshot(editor);

    if (this.idleTriggerTimer) {
      clearTimeout(this.idleTriggerTimer);
    }

    this.idleTriggerTimer = setTimeout(() => {
      const snapshot = this.idleTriggerSnapshot;
      this.idleTriggerTimer = undefined;
      this.idleTriggerSnapshot = undefined;
      this.runIdleTrigger(snapshot);
    }, delayMs);
  }

  runIdleTrigger(snapshot) {
    const editor = this.vscode.window.activeTextEditor;
    const config = this.readAutomaticConfig();
    if (
      !config.enabled
      || !config.idleTriggerEnabled
      || !snapshot
      || !this.matchesEditorSnapshot(editor, snapshot)
      || !this.canIdleTrigger(editor, config)
    ) {
      return;
    }

    this.lastIdleTriggerAt = Date.now();
    this.pendingIdleTriggerSnapshot = snapshot;
    setTimeout(() => {
      if (this.pendingIdleTriggerSnapshot === snapshot) {
        this.pendingIdleTriggerSnapshot = undefined;
      }
    }, IDLE_TRIGGER_PENDING_MS);
    this.executeInlineSuggestTrigger();
  }

  canIdleTrigger(editor, config) {
    if (!editor || this.activeRequest) {
      return false;
    }

    return this.canProvide(
      editor.document,
      editor.selection.active,
      { triggerKind: this.vscode.InlineCompletionTriggerKind.Automatic },
      { isCancellationRequested: false },
      config
    );
  }

  matchesEditorSnapshot(editor, snapshot) {
    return editor
      && editor.document.uri.toString() === snapshot.documentUri
      && editor.document.version === snapshot.documentVersion
      && editor.selection.isEmpty
      && editor.selection.active.line === snapshot.positionLine
      && editor.selection.active.character === snapshot.positionCharacter;
  }

  clearIdleTrigger() {
    if (this.idleTriggerTimer) {
      clearTimeout(this.idleTriggerTimer);
      this.idleTriggerTimer = undefined;
    }
    this.idleTriggerSnapshot = undefined;
  }

  takeMatchingIdleTriggerSnapshot(document, position) {
    const snapshot = this.pendingIdleTriggerSnapshot;
    if (!snapshot) {
      return false;
    }

    this.pendingIdleTriggerSnapshot = undefined;
    return document.uri.toString() === snapshot.documentUri
      && document.version === snapshot.documentVersion
      && position.line === snapshot.positionLine
      && position.character === snapshot.positionCharacter;
  }

  readAutomaticConfig() {
    return CompletionConfig.fromWorkspace(
      this.vscode.workspace.getConfiguration("tabtab"),
      { triggerKind: this.vscode.InlineCompletionTriggerKind.Automatic },
      this.vscode
    );
  }

  executeInlineSuggestTrigger(errorPrefix = "Inline suggestion trigger failed") {
    if (this.vscode && this.vscode.commands && typeof this.vscode.commands.executeCommand === "function") {
      this.vscode.commands.executeCommand(INLINE_SUGGEST_TRIGGER_COMMAND).catch((error) => {
        this.logError(`${errorPrefix}: ${error.message || String(error)}`);
      });
    }
  }

  logError(message) {
    if (message === this.lastError) {
      return;
    }

    this.lastError = message;
    if (this.output && typeof this.output.appendLine === "function") {
      this.output.appendLine(message);
    }
  }
}

function makeRequestKey(document, position, documentVersion, config) {
  return [
    document.uri.toString(),
    documentVersion,
    position.line,
    position.character,
    config.isManual ? "manual" : "auto"
  ].join(":");
}

function makeEditorSnapshot(editor) {
  return {
    documentUri: editor.document.uri.toString(),
    documentVersion: editor.document.version,
    positionLine: editor.selection.active.line,
    positionCharacter: editor.selection.active.character
  };
}

module.exports = {
  InlineCompletionProvider
};
