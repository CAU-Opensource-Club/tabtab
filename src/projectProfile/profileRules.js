const fs = require("fs");
const path = require("path");
const { sanitizeProfile } = require("./profileConfig");
const { normalizeRelativePath, comparePaths } = require("./projectStructure");

const EXACT_MANIFEST_PATHS = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "CMakeLists.txt",
  "Makefile",
  "GNUmakefile",
  "makefile",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "requirements.txt",
  "extension.ts",
  "extension.js",
  "src/extension.ts",
  "src/extension.js"
];

async function collectManifestInfo(root, files) {
  const fileSet = new Set(files);
  const manifestPaths = new Set(EXACT_MANIFEST_PATHS);

  for (const file of files) {
    if (isRootConfigMatch(file, "vite.config.") || isRootConfigMatch(file, "next.config.")) {
      manifestPaths.add(file);
    }
  }

  const entries = [];
  for (const relativePath of Array.from(manifestPaths).sort(comparePaths)) {
    const existsInStructure = fileSet.has(relativePath);
    let stat;

    try {
      stat = await fs.promises.stat(path.join(root, relativePath));
    } catch (error) {
      stat = undefined;
    }

    entries.push({
      path: relativePath,
      exists: Boolean(existsInStructure || stat),
      mtimeMs: stat ? Math.trunc(stat.mtimeMs) : 0,
      size: stat ? stat.size : 0
    });
  }

  return entries;
}

async function readPackageJson(root) {
  try {
    const raw = await fs.promises.readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch (error) {
    return undefined;
  }
}

function detectProjectProfileFromRules({ files, packageJson }) {
  const fileSet = new Set(files);
  const hasPackageJson = fileSet.has("package.json") || Boolean(packageJson);
  const language = inferJsLanguage(fileSet, packageJson);

  if (hasPackageJson && isVscodeExtension(fileSet, packageJson)) {
    const purpose = hasFimSignal(fileSet) ? " for FIM inline completion" : "";
    return sanitizeProfile(`${language} VSCode extension${purpose}; prefer VSCode Extension API patterns.`);
  }

  if (hasPackageJson && hasRootPrefix(fileSet, "vite.config.")) {
    return sanitizeProfile(`${language} Vite frontend project; prefer project-local UI and build patterns.`);
  }

  if (hasPackageJson && hasRootPrefix(fileSet, "next.config.")) {
    return sanitizeProfile(`${language} Next.js project; prefer Next.js and project-local React patterns.`);
  }

  if (fileSet.has("pyproject.toml")) {
    return "Python project; prefer project-local package and tooling patterns.";
  }

  if (fileSet.has("Cargo.toml")) {
    return "Rust project; prefer Cargo workspace and idiomatic Rust patterns.";
  }

  if (fileSet.has("go.mod")) {
    return "Go project; prefer module-local packages and idiomatic Go patterns.";
  }

  const domainProfile = inferDomainProfile(fileSet);
  if (domainProfile) {
    return domainProfile;
  }

  if (fileSet.has("CMakeLists.txt")) {
    return "C/C++ CMake project; prefer existing targets and modern C++ patterns.";
  }

  if (hasMakefile(fileSet)) {
    return "C/C++ Makefile project; prefer existing make targets and modern C++ patterns.";
  }

  if (fileSet.has("pom.xml")) {
    return "Maven Java project; prefer existing Maven module and JVM patterns.";
  }

  if (fileSet.has("build.gradle")) {
    return "Gradle JVM project; prefer existing Gradle module and JVM patterns.";
  }

  if (hasPackageJson) {
    return sanitizeProfile(`${language} project; prefer project-local module and tooling patterns.`);
  }

  return "";
}

function inferDomainProfile(fileSet) {
  const hasDataPlane = hasPathPrefix(fileSet, "src/data_plane/")
    || hasPathPrefix(fileSet, "src/dataplane/");
  const hasControlPlane = hasPathPrefix(fileSet, "src/control_plane/")
    || hasPathPrefix(fileSet, "src/controlplane/");
  const hasNetProtocol = hasPathPrefix(fileSet, "src/net/protocol/");
  const hasRouterTables = hasPathPrefix(fileSet, "src/net/service/fib/")
    || hasPathPrefix(fileSet, "src/net/service/fdb/")
    || hasPathPrefix(fileSet, "src/net/service/nat/");
  const hasEbpfXdp = hasPathPrefix(fileSet, "ebpf/")
    || hasPathSubstring(fileSet, "xdp");

  if (
    (hasDataPlane && hasControlPlane && hasNetProtocol)
    || (hasDataPlane && hasRouterTables)
    || (hasEbpfXdp && hasNetProtocol)
  ) {
    return "High-performance C++ router/data-plane project with eBPF/XDP networking; prefer low-latency packet-processing patterns.";
  }

  if (hasNetProtocol && hasRouterTables) {
    return "C++ router/networking project; prefer packet-processing, protocol parsing, and table-management patterns.";
  }

  if (hasEbpfXdp) {
    return "C/C++ eBPF/XDP networking project; prefer low-level packet-processing and kernel/userspace boundary patterns.";
  }

  return "";
}

function isVscodeExtension(fileSet, packageJson) {
  if (packageJson && packageJson.engines && packageJson.engines.vscode) {
    return true;
  }

  if (packageJson && packageJson.contributes && typeof packageJson.contributes === "object") {
    return true;
  }

  if (!packageJson) {
    return false;
  }

  const main = typeof packageJson.main === "string" ? normalizeRelativePath(packageJson.main) : "";
  return Boolean(main && (main === "extension.js" || main === "extension.ts" || main.startsWith("src/extension.")));
}

function inferJsLanguage(fileSet, packageJson) {
  if (
    fileSet.has("tsconfig.json")
    || fileSet.has("extension.ts")
    || fileSet.has("src/extension.ts")
    || hasExtension(fileSet, ".ts")
    || hasExtension(fileSet, ".tsx")
  ) {
    return "TypeScript";
  }

  const devDependencies = packageJson && packageJson.devDependencies;
  if (devDependencies && typeof devDependencies === "object" && devDependencies.typescript) {
    return "TypeScript";
  }

  return "JavaScript";
}

function hasFimSignal(fileSet) {
  for (const file of fileSet) {
    const lower = file.toLowerCase();
    if (lower.includes("fim") || lower.includes("inlinecompletion")) {
      return true;
    }
  }

  return false;
}

function hasMakefile(fileSet) {
  return fileSet.has("Makefile") || fileSet.has("makefile") || fileSet.has("GNUmakefile");
}

function hasExtension(fileSet, extension) {
  for (const file of fileSet) {
    if (file.toLowerCase().endsWith(extension)) {
      return true;
    }
  }

  return false;
}

function hasRootPrefix(fileSet, prefix) {
  for (const file of fileSet) {
    if (isRootConfigMatch(file, prefix)) {
      return true;
    }
  }

  return false;
}

function hasPathPrefix(fileSet, prefix) {
  for (const file of fileSet) {
    if (file.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function hasPathSubstring(fileSet, value) {
  for (const file of fileSet) {
    if (file.includes(value)) {
      return true;
    }
  }

  return false;
}

function isRootConfigMatch(file, prefix) {
  return !file.includes("/") && file.startsWith(prefix);
}

module.exports = {
  collectManifestInfo,
  readPackageJson,
  detectProjectProfileFromRules
};
