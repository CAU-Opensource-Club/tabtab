function looksLikeCompleteStatementEnd(linePrefix, lineSuffix) {
  const prefix = String(linePrefix || "").trimEnd();
  return !String(lineSuffix || "").trim()
    && prefix.endsWith(";")
    && hasClosedGrouping(prefix);
}

function hasClosedGrouping(text) {
  const counts = {
    "(": 0,
    "[": 0,
    "{": 0
  };

  for (const char of text) {
    if (char === "(" || char === "[" || char === "{") {
      counts[char] += 1;
    } else if (char === ")") {
      counts["("] -= 1;
    } else if (char === "]") {
      counts["["] -= 1;
    } else if (char === "}") {
      counts["{"] -= 1;
    }
  }

  return counts["("] <= 0 && counts["["] <= 0 && counts["{"] <= 0;
}

module.exports = {
  looksLikeCompleteStatementEnd
};
