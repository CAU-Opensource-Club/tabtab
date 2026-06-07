# TabTab

Minimal VS Code Tab/FIM inline code completion extension backed by OpenAI-compatible or Anthropic-compatible APIs.

## Features

- Inline ghost-text code completion through `InlineCompletionItemProvider`.
- FIM-style prompts: prefix + suffix + related context -> inserted code only.
- Supports OpenAI-compatible Chat Completions format.
- Supports Anthropic-compatible Messages format.
- Defaults to OpenAI-compatible format with `deepseek-v4-flash`.
- Sends `thinking: { "type": "disabled" }` by default on OpenAI-compatible requests for low-latency completions.
- Debounces automatic completions by 250ms and cancels or discards stale requests when the user keeps typing.
- Uses an approximate 8192-token prompt budget split into prefix 65%, suffix 20%, and extra context 15%.
- Extra context can include open related files, C++ `.h`/`.cpp` pairs, LSP definition/declaration snippets, and recently edited files.
- Filters `.git`, build/dist output, dependency/vendor folders, lock files, env/secret files, and large generated files.
- Post-processes model output to remove Markdown fences, explanations, duplicated prefix/suffix text, and overly long completions.
- Stores API format, API URL, model, and API key in `tabtab.config.json`.
- Stores the system prompt in `tabtab.system-prompt.txt`.

## Usage

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new VS Code window, click the TabTab icon in the Activity Bar.
4. Set the API format, API key, API URL, model, and system prompt.
5. Click `Test API` to verify that requests reach the selected API.
6. Start typing code. Accept inline suggestions with `Tab`.

If `tabtab.config.json` or `tabtab.system-prompt.txt` does not exist, TabTab creates it automatically with default values.
If they already exist, the TabTab settings view reads and writes those files. The API key field is shown as a password input.
API request start and return timing is written to `Output > TabTab`.

## Settings

- `tabtab.enabled`
- `tabtab.maxTokens`
- `tabtab.debounceMs`
- `tabtab.maxPromptTokens`
- `tabtab.maxOutputTokens`
- `tabtab.manualMaxOutputTokens`
- `tabtab.temperature`
- `tabtab.maxCompletionLines`
- `tabtab.manualMaxCompletionLines`
- `tabtab.maxRelatedFiles`
- `tabtab.maxRelatedFileBytes`
- `tabtab.lspTimeoutMs`
- `tabtab.sendThinkingDisabled`
- `tabtab.requestTimeoutMs`
