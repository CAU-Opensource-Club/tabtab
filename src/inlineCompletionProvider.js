const { Config } = require("./config");
const { ContextBuilder } = require("./contextBuilder");
const { RelatedFileSelector } = require("./relatedFileSelector");
const { FimClient } = require("./fimClient");
const { CompletionPostProcessor } = require("./completionPostProcessor");

class InlineCompletionProvider {
  constructor(options) {
    this.vscode = options.vscode;
    this.context = options.context;
    this.output = options.output;
    this.readRuntimeConfig = options.readRuntimeConfig;
    this.lastError = "";
    this.activeRequest = undefined;
    this.relatedFileSelector = new RelatedFileSelector({
      vscode: this.vscode,
      context: this.context,
      output: this.output
    });
    this.contextBuilder = new ContextBuilder({
      relatedFileSelector: this.relatedFileSelector
    });
    this.fimClient = new FimClient({
      output: this.output,
      ...options.defaults
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
            this.cancelActiveRequest();
          }
        })
      );
    }
  }

  async provideInlineCompletionItems(document, position, inlineContext, token) {
    const workspaceConfig = this.vscode.workspace.getConfiguration("tabtab");
    const config = Config.fromWorkspace(workspaceConfig, inlineContext, this.vscode);

    if (!this.canProvide(document, position, inlineContext, token, config)) {
      return undefined;
    }

    const documentVersion = document.version;
    const requestKey = makeRequestKey(document, position, documentVersion, config);

    if (this.activeRequest && this.activeRequest.key === requestKey) {
      const sharedResult = await this.activeRequest.promise;
      return token.isCancellationRequested ? undefined : sharedResult;
    }

    if (this.activeRequest) {
      this.cancelActiveRequest();
    }

    const controller = new AbortController();
    const request = {
      key: requestKey,
      documentUri: document.uri.toString(),
      documentVersion,
      controller,
      promise: undefined
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
      if (!config.isManual) {
        await delay(config.debounceMs, requestToken, controller.signal);
      }

      if (this.isStale(document, documentVersion, request)) {
        return undefined;
      }

      const runtimeConfig = await this.readRuntimeConfig();
      if (!runtimeConfig || !runtimeConfig.apiKey) {
        this.logError("Missing API key. Set apiKey in tabtab.config.json.");
        return undefined;
      }

      const fimContext = await this.contextBuilder.build({
        document,
        position,
        token: requestToken,
        config
      });

      if (this.isStale(document, documentVersion, request)) {
        return undefined;
      }

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

      const completion = this.postProcessor.process({
        raw: rawCompletion,
        context: fimContext,
        config
      });

      if (!completion || this.isStale(document, documentVersion, request)) {
        return undefined;
      }

      return {
        items: [
          new this.vscode.InlineCompletionItem(
            completion,
            new this.vscode.Range(position, position)
          )
        ]
      };
    } catch (error) {
      if (error && (error.name === "AbortError" || error.message === "cancelled")) {
        return undefined;
      }

      this.logError(`Inline completion failed: ${error.message || String(error)}`);
      return undefined;
    } finally {
      if (this.activeRequest === request) {
        this.activeRequest = undefined;
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
      const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
      if (!linePrefix.trim()) {
        return false;
      }
    }

    return true;
  }

  isStale(document, documentVersion, request) {
    return request.controller.signal.aborted
      || this.activeRequest !== request
      || document.version !== documentVersion;
  }

  cancelActiveRequest() {
    if (this.activeRequest) {
      this.activeRequest.controller.abort();
      this.activeRequest = undefined;
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

function createControllerToken(controller) {
  return {
    get isCancellationRequested() {
      return controller.signal.aborted;
    },
    onCancellationRequested(callback) {
      if (controller.signal.aborted) {
        callback();
        return { dispose() {} };
      }

      controller.signal.addEventListener("abort", callback, { once: true });
      return {
        dispose() {
          controller.signal.removeEventListener("abort", callback);
        }
      };
    }
  };
}

function delay(ms, token, signal) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = [];
    const finish = (callback, value) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      for (const dispose of cleanup) {
        dispose();
      }
      callback(value);
    };
    const timeout = setTimeout(() => finish(resolve), ms);
    const cancel = () => {
      finish(reject, new Error("cancelled"));
    };

    if (token && token.isCancellationRequested) {
      cancel();
      return;
    }

    if (token && typeof token.onCancellationRequested === "function") {
      const disposable = token.onCancellationRequested(cancel);
      cleanup.push(() => disposable.dispose());
    }

    if (signal) {
      if (signal.aborted) {
        cancel();
        return;
      }

      const listener = cancel;
      signal.addEventListener("abort", listener, { once: true });
      cleanup.push(() => signal.removeEventListener("abort", listener));
    }
  });
}

function withTimeout(promise, timeoutMs, controller) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (controller) {
        controller.abort();
      }
      reject(new Error("cancelled"));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

module.exports = {
  InlineCompletionProvider
};
