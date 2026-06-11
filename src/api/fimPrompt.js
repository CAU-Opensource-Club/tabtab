const { normalizeNewlines, sanitizeSingleLine } = require("../shared/textUtils");

const PROJECT_PROFILE_MAX_CHARS = 300;
const FIXED_FIM_RULES = [
  "Fill the cursor gap using FIM.",
  "Return only the inserted text.",
  "Do not return Markdown, explanations, tags, or code that already exists in prefix or suffix.",
  "Prefer a short local completion. The returned text will be inserted exactly at <cursor>."
];
const WORKSPACE_STRATEGY = [
  "Use project profile, diagnostics, and related context as supporting information for the cursor completion.",
  "Prefer the current file prefix and suffix when workspace context conflicts with local code."
];
const PROMPT_TAG_NAMES = [
  "fim_prefix",
  "fim_suffix",
  "project_profile",
  "workspace_strategy",
  "metadata",
  "diagnostics_context",
  "extra_context",
  "before_cursor",
  "after_cursor",
  "cursor"
];
const PROMPT_TAG_LINE_PATTERN = new RegExp(`^</?(${PROMPT_TAG_NAMES.join("|")})>$`, "i");

function buildFimPrompt(context) {
  const metadata = context.metadata || {};
  const diagnosticContextSections = Array.isArray(context.cachedContextSections)
    ? context.cachedContextSections.map((section) => String(section || "").trim()).filter(Boolean)
    : [];
  const extra = context.extraContext && context.extraContext.trim()
    ? ["<extra_context>", context.extraContext, "</extra_context>", ""]
    : [];
  const projectProfile = sanitizeSingleLine(context.projectProfile, PROJECT_PROFILE_MAX_CHARS);

  return [
    ...FIXED_FIM_RULES,
    "",
    ...formatProjectProfileSection(projectProfile),
    ...formatWorkspaceStrategySection(),
    ...formatMetadataSection(metadata),
    ...formatDiagnosticContextSections(diagnosticContextSections),
    ...extra,
    "<fim_prefix>",
    context.prefix || "",
    "</fim_prefix>",
    "<fim_suffix>",
    context.suffix || "",
    "</fim_suffix>"
  ].join("\n");
}

function buildStopSequences(context) {
  const metadata = context && context.metadata ? context.metadata : {};
  const suffixText = [
    metadata.lineSuffix || "",
    context && context.suffix ? context.suffix : ""
  ].filter(Boolean).join("\n");
  const sequences = [];
  const seen = new Set();

  for (const line of normalizeNewlines(suffixText).split("\n")) {
    const sequence = line.replace(/[ \t]+$/g, "");
    const normalized = sequence.trim().replace(/\s+/g, " ");

    if (!isUsefulStopSequence(sequence) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    sequences.push(sequence.slice(0, 160));

    if (sequences.length >= 3) {
      break;
    }
  }

  return sequences;
}

function isUsefulStopSequence(line) {
  const text = String(line || "").trim();

  return text.length >= 24
    && !PROMPT_TAG_LINE_PATTERN.test(text)
    && !/^[{}()[\],;.\s]+$/.test(text);
}

function formatProjectProfileSection(projectProfile) {
  if (!projectProfile) {
    return [];
  }

  return [
    "<project_profile>",
    `Project profile: ${projectProfile}`,
    "</project_profile>",
    ""
  ];
}

function formatWorkspaceStrategySection() {
  return [
    "<workspace_strategy>",
    WORKSPACE_STRATEGY.join("\n"),
    "</workspace_strategy>",
    ""
  ];
}

function formatMetadataSection(metadata) {
  const lines = [
    `Language: ${metadata.languageId || "unknown"}`,
    `File: ${metadata.fileName || "unknown"}`,
    ...buildCursorInstructions(metadata)
  ];

  return [
    "<metadata>",
    lines.join("\n"),
    "</metadata>",
    ""
  ];
}

function formatDiagnosticContextSections(sections) {
  if (!sections.length) {
    return [];
  }

  return [
    "<diagnostics_context>",
    sections.join("\n\n"),
    "</diagnostics_context>",
    ""
  ];
}

function buildCursorInstructions(metadata) {
  const cursorComment = metadata.cursorComment || {};
  if (!cursorComment.inside) {
    return [];
  }

  if (cursorComment.kind === "block") {
    return [
      "Cursor context: inside a block comment. Continue the comment text in the current comment style. Do not switch to code."
    ];
  }

  return [
    "Cursor context: inside a line comment. Continue the comment text in the current comment style. Do not switch to code."
  ];
}

module.exports = {
  PROMPT_TAG_NAMES,
  buildFimPrompt,
  buildStopSequences
};
