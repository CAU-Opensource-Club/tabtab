const CONFIG_FILE_NAME = "tabtab.config.json";
const SYSTEM_PROMPT_FILE_NAME = "tabtab.system-prompt.txt";
const LEGACY_API_KEY_SECRET = "tabtab.deepseekApiKey";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

const DEFAULT_SYSTEM_PROMPT = `You are a code completion engine, not a chat assistant.

Complete the code at the cursor using the surrounding file context.

Rules:
- Return only the code completion text.
- Do not use Markdown.
- Do not explain.
- Do not repeat code that already exists before and after the cursor.
- Keep the completion minimal and local.
- Prefer the style, naming, formatting, and abstractions already used in the file.
- Do not introduce large refactors.
- Do not invent unrelated APIs.
- Prefer simple, readable, type-safe code.
- For C++, prefer modern C++17/20 style, RAII, constexpr where useful, strong typing where appropriate, and avoid unnecessary dynamic allocation.
- In hot-path or systems code, avoid hidden allocations, exceptions, virtual dispatch, locks, and excessive abstraction unless the surrounding code already uses them.
- Preserve const-correctness, noexcept, alignment, and cache-conscious layout when relevant.
- If the cursor is inside a comment, continue the comment text instead of writing code.
- Complete only what is very likely intended from the immediate context.`;

function getDefaultBaseUrl(provider) {
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
}

function getDefaultModel(provider) {
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_MODEL;
}

module.exports = {
  CONFIG_FILE_NAME,
  SYSTEM_PROMPT_FILE_NAME,
  LEGACY_API_KEY_SECRET,
  DEFAULT_BASE_URL,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  getDefaultBaseUrl,
  getDefaultModel
};
