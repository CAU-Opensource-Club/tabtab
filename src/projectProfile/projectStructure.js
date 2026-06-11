const childProcess = require("child_process");
const path = require("path");
const { replaceControlChars } = require("../shared/textUtils");

const GIT_TIMEOUT_MS = 1500;
const STRUCTURE_COMMAND_TIMEOUT_MS = 1500;

const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".vscode",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "third_party",
  "vendor"
]);

const COMMON_LOCK_FILES = new Set([
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock"
]);

async function listGitFiles(root, limits) {
  return streamCommandPaths({
    root,
    command: "git",
    args: ["ls-files", "-z"],
    separator: "\0",
    limits,
    timeoutMs: GIT_TIMEOUT_MS,
    normalizePath: normalizeRelativePath
  });
}

async function listFindFiles(root, limits) {
  const pruneArgs = [];
  for (const directory of EXCLUDED_DIRECTORIES) {
    if (pruneArgs.length) {
      pruneArgs.push("-o");
    }
    pruneArgs.push("-name", directory);
  }

  const args = [
    ".",
    "(",
    ...pruneArgs,
    ")",
    "-prune",
    "-o",
    "-type",
    "f",
    "-print"
  ];

  return streamCommandPaths({
    root,
    command: "find",
    args,
    separator: "\n",
    limits,
    timeoutMs: STRUCTURE_COMMAND_TIMEOUT_MS,
    normalizePath: normalizeRelativePath
  });
}

async function listTreeFiles(root, limits) {
  const ignorePattern = [
    ...EXCLUDED_DIRECTORIES,
    "*.lock",
    "*.min.js",
    "*.map"
  ].join("|");

  return streamCommandPaths({
    root,
    command: "tree",
    args: ["-a", "-f", "-i", "-F", "--noreport", "-I", ignorePattern, "."],
    separator: "\n",
    limits,
    timeoutMs: STRUCTURE_COMMAND_TIMEOUT_MS,
    normalizePath: normalizeTreePath
  });
}

async function streamCommandPaths({ root, command, args, separator, limits, timeoutMs, normalizePath }) {
  return new Promise((resolve, reject) => {
    const files = [];
    let chars = 0;
    let pending = "";
    let finished = false;
    let stderr = "";
    const child = childProcess.spawn(command, args, {
      cwd: root,
      shell: false
    });
    const timer = setTimeout(() => {
      finish(reject, new Error(`${command} timed out`));
      child.kill();
    }, timeoutMs);

    const finish = (callback, value) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      callback(value);
    };

    const consume = (includeTail) => {
      while (pending && !finished) {
        const index = pending.indexOf(separator);
        if (index < 0) {
          if (includeTail) {
            addPath(pending);
            pending = "";
          }
          break;
        }

        addPath(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    };

    const addPath = (rawPath) => {
      if (finished) {
        return;
      }

      const cleaned = separator === "\n" ? rawPath.replace(/\r$/, "") : rawPath;
      const file = normalizePath(cleaned);
      if (!file || isExcludedPath(file) || files.length >= limits.maxFiles) {
        return;
      }

      const nextChars = chars + file.length + 1;
      if (nextChars > limits.maxChars) {
        finish(resolve, files);
        child.kill();
        return;
      }

      files.push(file);
      chars = nextChars;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      consume(false);

      if (!finished && files.length >= limits.maxFiles) {
        finish(resolve, files);
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (finished) {
        return;
      }

      consume(true);
      if (code === 0) {
        finish(resolve, files.sort(comparePaths));
      } else {
        finish(reject, new Error(stderr.trim() || `${command} exited with ${code}`));
      }
    });
  });
}

async function getGitHead(root) {
  try {
    return replaceControlChars(await runGitText(root, ["rev-parse", "HEAD"], GIT_TIMEOUT_MS)).trim();
  } catch (error) {
    return "";
  }
}

async function runGitText(root, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    const child = childProcess.spawn("git", args, {
      cwd: root,
      shell: false
    });
    const timer = setTimeout(() => {
      finish(reject, new Error("git command timed out"));
      child.kill();
    }, timeoutMs);

    const finish = (callback, value) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      callback(value);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, stdout);
      } else {
        finish(reject, new Error(stderr.trim() || `git ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

function applyListLimits(files, limits) {
  const result = [];
  let chars = 0;

  for (const rawFile of files) {
    if (result.length >= limits.maxFiles) {
      break;
    }

    const file = normalizeRelativePath(rawFile);
    if (!file || isExcludedPath(file)) {
      continue;
    }

    const nextChars = chars + file.length + 1;
    if (nextChars > limits.maxChars) {
      break;
    }

    result.push(file);
    chars = nextChars;
  }

  return result;
}

function isExcludedPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  if (!normalized) {
    return true;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
    return true;
  }

  const baseName = path.posix.basename(normalized);
  return baseName.endsWith(".lock")
    || baseName.endsWith(".min.js")
    || baseName.endsWith(".map")
    || COMMON_LOCK_FILES.has(baseName);
}

function normalizeRelativePath(value) {
  const cleaned = replaceControlChars(value)
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .trim();

  if (!cleaned) {
    return "";
  }

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    return "";
  }

  return parts.join("/");
}

function normalizeTreePath(value) {
  const text = replaceControlChars(value).trim();
  if (!text || text.endsWith("/")) {
    return "";
  }

  return normalizeRelativePath(text.replace(/[*=@|]$/, ""));
}

function comparePaths(left, right) {
  return left.localeCompare(right);
}

module.exports = {
  listGitFiles,
  listFindFiles,
  listTreeFiles,
  getGitHead,
  applyListLimits,
  isExcludedPath,
  normalizeRelativePath,
  comparePaths
};
