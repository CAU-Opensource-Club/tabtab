const DEFAULT_LIMITS = {
  maxInjectedChars: 1200,
  maxProjectProfileChars: 300,
  maxStandardIncludes: 5,
  maxProjectIncludes: 3,
  maxDiagnostics: 8
};

class FimContextBuilder {
  buildPromptSections(snapshot, options = {}) {
    const limits = {
      ...DEFAULT_LIMITS,
      ...options
    };
    const sections = [];

    if (snapshot && snapshot.projectProfile) {
      sections.push(formatProjectProfile(snapshot.projectProfile, limits.maxProjectProfileChars));
    }

    if (snapshot && Array.isArray(snapshot.missingStandardIncludes) && snapshot.missingStandardIncludes.length) {
      sections.push(formatStandardIncludeHints(snapshot.missingStandardIncludes.slice(0, limits.maxStandardIncludes)));
    }

    if (snapshot && Array.isArray(snapshot.missingProjectIncludes) && snapshot.missingProjectIncludes.length) {
      sections.push(formatProjectIncludeHints(snapshot.missingProjectIncludes.slice(0, limits.maxProjectIncludes)));
    }

    if (snapshot && snapshot.includeRegion && hasMissingIncludeHints(snapshot)) {
      sections.push([
        "The cursor is in the include region. If diagnostics indicate missing C++ standard or project-local headers, prefer completing the missing #include lines before ordinary code completion.",
        "Return only the completion text.",
        "Do not repeat existing includes.",
        "Prefer standard library angle includes for standard symbols.",
        "Prefer project-local quote includes for project symbols.",
        "Do not invent unrelated headers."
      ].join("\n"));
    }

    if (snapshot && Array.isArray(snapshot.diagnosticsContext) && snapshot.diagnosticsContext.length) {
      sections.push(formatDiagnostics(snapshot.diagnosticsContext.slice(0, limits.maxDiagnostics)));
    }

    return fitSections(sections.filter(Boolean), limits.maxInjectedChars);
  }
}

function formatProjectProfile(profile, maxChars) {
  const value = sanitizeSingleLine(profile).slice(0, Math.max(0, maxChars || 0)).trim();
  return value ? `Project profile: ${value}` : "";
}

function formatStandardIncludeHints(hints) {
  const lines = ["Likely missing C++ standard library includes:"];
  for (const hint of hints) {
    const symbol = hint.symbol ? ` for ${hint.symbol}` : "";
    lines.push(`- ${hint.header}${symbol}, diagnostic line ${hint.line}: ${sanitizeSingleLine(hint.message)}`);
  }
  return lines.join("\n");
}

function formatProjectIncludeHints(hints) {
  const lines = ["Likely missing project-local includes:"];
  for (const hint of hints) {
    lines.push(`- ${hint.includeText} for ${hint.symbol}, diagnostic line ${hint.line}: ${sanitizeSingleLine(hint.message)}`);
  }
  return lines.join("\n");
}

function formatDiagnostics(diagnostics) {
  const lines = ["Current file diagnostics near cursor:"];
  for (const diagnostic of diagnostics) {
    const severity = diagnostic.severity === 0 ? "Error" : "Warning";
    const line = diagnostic.range && diagnostic.range.start ? diagnostic.range.start.line + 1 : 1;
    const source = diagnostic.source ? ` ${diagnostic.source}` : "";
    lines.push(`- ${severity}${source} line ${line}: ${sanitizeSingleLine(diagnostic.message)}`);
  }
  return lines.join("\n");
}

function fitSections(sections, maxChars) {
  const limit = Math.max(0, maxChars || 0);
  const result = [];
  let used = 0;

  for (const section of sections) {
    const value = String(section || "").trim();
    if (!value) {
      continue;
    }

    const separator = result.length ? 2 : 0;
    const remaining = limit - used - separator;
    if (remaining <= 0) {
      break;
    }

    if (value.length <= remaining) {
      result.push(value);
      used += value.length + separator;
      continue;
    }

    result.push(trimSection(value, remaining));
    break;
  }

  return result.filter(Boolean);
}

function trimSection(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }

  const trimmed = value.slice(0, Math.max(0, maxChars));
  const lastNewline = trimmed.lastIndexOf("\n");
  return (lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed).trim();
}

function hasMissingIncludeHints(snapshot) {
  return Boolean(
    (snapshot.missingStandardIncludes && snapshot.missingStandardIncludes.length)
    || (snapshot.missingProjectIncludes && snapshot.missingProjectIncludes.length)
  );
}

function sanitizeSingleLine(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  FimContextBuilder,
  DEFAULT_LIMITS
};
