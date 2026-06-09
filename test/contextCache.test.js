const assert = require("assert").strict;
const { DiagnosticsCache } = require("../src/context/diagnosticsCache");
const { FimContextBuilder } = require("../src/context/fimContextBuilder");
const { IncludeAssist, collectExistingIncludes, isCursorInIncludeRegion } = require("../src/context/includeAssist");
const { LocalHeaderIndex, extractHeaderSymbolsFromText } = require("../src/context/localHeaderIndex");
const { ProjectProfileCache } = require("../src/context/projectProfileCache");
const { WorkspaceContextCache } = require("../src/context/workspaceContextCache");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("ProjectProfileCache returns a compact project profile from the project profile service", () => {
  const longProfile = "JavaScript VSCode extension implementing FIM inline completion. ".repeat(10);
  const cache = new ProjectProfileCache({
    projectProfileService: {
      isEnabled() {
        return true;
      },
      getManualProfile() {
        return "";
      },
      getWorkspaceFolderForDocument() {
        return { uri: makeUri("/repo") };
      },
      getCachedEntry() {
        return { profile: longProfile };
      }
    }
  });

  const profile = cache.getForDocument(makeDocument({ text: "", languageId: "javascript" }));
  assert.match(profile, /^JavaScript VSCode extension/);
  assert.ok(profile.length <= 300);
});

test("DiagnosticsCache reads workspace diagnostics and keeps only Error and Warning", () => {
  const uri = makeUri("/repo/src/main.cpp");
  const vscode = makeVscode({
    diagnostics: new Map([
      [uri.toString(), [
        makeDiagnostic({ message: "error", line: 10, severity: 0 }),
        makeDiagnostic({ message: "warning", line: 12, severity: 1 }),
        makeDiagnostic({ message: "info", line: 13, severity: 2 })
      ]]
    ])
  });
  const cache = new DiagnosticsCache({ vscode });
  const document = makeDocument({ uri, text: "", languageId: "cpp" });

  const all = cache.getForDocument(document);
  const near = cache.getNearPosition(document, { line: 9, character: 0 }, 0, 1);

  assert.deepEqual(all.map((diagnostic) => diagnostic.message), ["error", "warning"]);
  assert.deepEqual(near.map((diagnostic) => diagnostic.message), ["error"]);
});

test("IncludeAssist infers <vector> from std namespace diagnostics", () => {
  const assist = new IncludeAssist();
  const document = makeDocument({ text: "#pragma once\n", languageId: "cpp" });
  const hints = assist.inferMissingStandardIncludes({
    document,
    position: { line: 5, character: 0 },
    diagnostics: [
      makeDiagnostic({
        message: "no template named 'vector' in namespace 'std'",
        line: 4,
        severity: 0
      })
    ]
  });

  assert.equal(hints[0].header, "<vector>");
  assert.equal(hints[0].symbol, "std::vector");
});

test("IncludeAssist infers <cstdint> for uint32_t and <cstddef> for size_t", () => {
  const assist = new IncludeAssist();
  const document = makeDocument({ text: "", languageId: "cpp" });
  const hints = assist.inferMissingStandardIncludes({
    document,
    diagnostics: [
      makeDiagnostic({ message: "use of undeclared identifier 'uint32_t'", line: 2 }),
      makeDiagnostic({ message: "unknown type name 'size_t'", line: 3 })
    ],
    position: { line: 1, character: 0 }
  });

  assert.deepEqual(hints.map((hint) => hint.header), ["<cstdint>", "<cstddef>"]);
});

test("IncludeAssist does not repeat existing includes", () => {
  const assist = new IncludeAssist();
  const document = makeDocument({
    text: [
      "#include <vector>",
      "#include \"memory/packet_buffer.hpp\"",
      ""
    ].join("\n"),
    languageId: "cpp"
  });
  const standardHints = assist.inferMissingStandardIncludes({
    document,
    diagnostics: [
      makeDiagnostic({ message: "namespace \"std\" has no member \"vector\"", line: 4 })
    ],
    position: { line: 4, character: 0 }
  });
  const projectHints = assist.inferMissingProjectIncludes({
    document,
    diagnostics: [
      makeDiagnostic({ message: "identifier \"PacketBufferMeta\" is undefined", line: 4 })
    ],
    position: { line: 4, character: 0 },
    localHeaderIndex: {
      lookupSymbol() {
        return [
          {
            name: "PacketBufferMeta",
            headerUri: makeUri("/repo/include/memory/packet_buffer.hpp"),
            includeText: "memory/packet_buffer.hpp",
            line: 3,
            confidence: "medium"
          }
        ];
      }
    }
  });

  assert.deepEqual(standardHints, []);
  assert.deepEqual(projectHints, []);
  assert.deepEqual([...collectExistingIncludes(document).angleIncludes], ["<vector>"]);
});

test("LocalHeaderIndex regex fallback indexes class and struct symbols", () => {
  const uri = makeUri("/repo/include/memory/packet_buffer.hpp");
  const symbols = extractHeaderSymbolsFromText({
    text: [
      "namespace memory {",
      "class PacketBufferMeta {};",
      "struct PacketBuffer {};",
      "}",
      ""
    ].join("\n"),
    uri,
    includeText: "memory/packet_buffer.hpp",
    vscode: makeVscode()
  });

  assert.deepEqual(symbols.map((symbol) => symbol.name), ["PacketBufferMeta", "PacketBuffer"]);
  assert.equal(symbols[0].qualifiedName, "memory::PacketBufferMeta");
});

test("IncludeAssist infers project-local include from undefined local symbol", () => {
  const assist = new IncludeAssist();
  const document = makeDocument({ text: "", languageId: "cpp", uri: makeUri("/repo/src/main.cpp") });
  const hints = assist.inferMissingProjectIncludes({
    document,
    position: { line: 30, character: 0 },
    diagnostics: [
      makeDiagnostic({
        message: "identifier \"PacketBufferMeta\" is undefined",
        line: 31,
        severity: 0
      })
    ],
    localHeaderIndex: {
      lookupSymbol(name) {
        assert.equal(name, "PacketBufferMeta");
        return [
          {
            name: "PacketBufferMeta",
            qualifiedName: "memory::PacketBufferMeta",
            headerUri: makeUri("/repo/include/memory/packet_buffer.hpp"),
            includeText: "memory/packet_buffer.hpp",
            line: 2,
            confidence: "medium"
          }
        ];
      }
    }
  });

  assert.equal(hints[0].includeText, "\"memory/packet_buffer.hpp\"");
  assert.equal(hints[0].symbol, "PacketBufferMeta");
});

test("FimContextBuilder adds include-region instruction only inside include region", () => {
  const builder = new FimContextBuilder();
  const baseSnapshot = {
    projectProfile: "",
    diagnosticsContext: [],
    missingStandardIncludes: [
      {
        header: "<vector>",
        symbol: "std::vector",
        line: 4,
        message: "no template named 'vector' in namespace 'std'",
        confidence: "high"
      }
    ],
    missingProjectIncludes: []
  };

  const includeSections = builder.buildPromptSections({
    ...baseSnapshot,
    includeRegion: true
  });
  const nonIncludeSections = builder.buildPromptSections({
    ...baseSnapshot,
    includeRegion: false
  });

  assert.match(includeSections.join("\n"), /prefer completing the missing #include lines/);
  assert.doesNotMatch(nonIncludeSections.join("\n"), /prefer completing the missing #include lines/);
});

test("isCursorInIncludeRegion handles include preamble conservatively", () => {
  const document = makeDocument({
    text: [
      "// header",
      "#pragma once",
      "#include <vector>",
      "",
      "class PacketBuffer {};",
      "",
      "void usePacketBuffer();",
      ""
    ].join("\n"),
    languageId: "cpp"
  });

  assert.equal(isCursorInIncludeRegion(document, { line: 3, character: 0 }), true);
  assert.equal(isCursorInIncludeRegion(document, { line: 6, character: 0 }), false);
});

test("WorkspaceContextCache gracefully returns empty sections when caches are not ready", async () => {
  const uri = makeUri("/repo/src/main.cpp");
  const vscode = makeVscode({
    diagnostics: new Map([
      [uri.toString(), [
        makeDiagnostic({ message: "no template named 'vector' in namespace 'std'", line: 8 })
      ]]
    ]),
    configValues: {
      "contextCache.enabled": true,
      "projectProfile.enabled": true,
      "includeAssist.enabled": false,
      "localHeaderIndex.enabled": false
    }
  });
  const cache = new WorkspaceContextCache({
    vscode,
    context: makeContext(),
    projectProfileService: {
      getPromptProfile() {
        return "";
      }
    }
  });
  const snapshot = await cache.buildSnapshot(
    makeDocument({ uri, text: "", languageId: "cpp" }),
    { line: 8, character: 0 },
    { isCancellationRequested: false }
  );

  assert.deepEqual(snapshot.missingStandardIncludes, []);
  assert.deepEqual(snapshot.missingProjectIncludes, []);
  assert.ok(Array.isArray(snapshot.promptSections));
});

test("LocalHeaderIndex refreshFile updates an existing header symbol entry", async () => {
  const uri = makeUri("/repo/include/memory/packet_buffer.hpp");
  let text = "class PacketBufferMeta {};";
  const vscode = makeVscode({
    fileText(uriToRead) {
      assert.equal(uriToRead.toString(), uri.toString());
      return text;
    }
  });
  const index = new LocalHeaderIndex({ vscode });

  await index.refreshFile(uri);
  assert.equal(index.lookupSymbol("PacketBufferMeta")[0].includeText, "memory/packet_buffer.hpp");

  text = "struct WorkerRuntime {};";
  await index.refreshFile(uri);
  assert.deepEqual(index.lookupSymbol("PacketBufferMeta"), []);
  assert.equal(index.lookupSymbol("WorkerRuntime")[0].includeText, "memory/packet_buffer.hpp");
});

test("LocalHeaderIndex excludes wildcard build directories on incremental refresh", () => {
  const index = new LocalHeaderIndex({ vscode: makeVscode() });
  assert.equal(index.isExcluded(makeUri("/repo/cmake-build-debug/generated.hpp")), true);
});

function makeVscode(options = {}) {
  const diagnostics = options.diagnostics || new Map();
  const configValues = {
    "contextCache.enabled": true,
    "projectProfile.enabled": true,
    "includeAssist.enabled": true,
    "includeAssist.standardLibrary.enabled": true,
    "includeAssist.projectHeaders.enabled": true,
    "localHeaderIndex.enabled": true,
    "localHeaderIndex.excludeGlobs": [
      "**/build/**",
      "**/cmake-build-*/**",
      "**/.git/**",
      "**/node_modules/**",
      "**/third_party/**",
      "**/external/**",
      "**/vendor/**"
    ],
    "contextCache.maxInjectedChars": 1200,
    ...(options.configValues || {})
  };

  return {
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3
    },
    SymbolKind: {
      Namespace: 3,
      Class: 4,
      Enum: 10,
      Interface: 11,
      Struct: 22,
      TypeAlias: 25
    },
    languages: {
      getDiagnostics(uri) {
        return diagnostics.get(uri.toString()) || [];
      },
      onDidChangeDiagnostics() {
        return { dispose() {} };
      }
    },
    workspace: {
      workspaceFolders: [
        { uri: makeUri("/repo") }
      ],
      getWorkspaceFolder(uri) {
        return uri && uri.fsPath && uri.fsPath.startsWith("/repo")
          ? { uri: makeUri("/repo") }
          : undefined;
      },
      getConfiguration() {
        return {
          get(key) {
            return configValues[key];
          }
        };
      },
      fs: {
        async readFile(uri) {
          return Buffer.from(options.fileText ? options.fileText(uri) : "", "utf8");
        }
      }
    },
    commands: {
      async executeCommand() {
        return undefined;
      }
    }
  };
}

function makeContext() {
  return {
    subscriptions: [],
    workspaceState: {
      get() {
        return undefined;
      },
      async update() {}
    }
  };
}

function makeDocument({ uri = makeUri("/repo/src/main.cpp"), text, languageId = "cpp" }) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  return {
    uri,
    languageId,
    version: 1,
    getText() {
      return normalized;
    },
    lineAt(line) {
      return {
        text: normalized.split("\n")[line] || ""
      };
    },
    offsetAt(position) {
      const lines = normalized.split("\n");
      let offset = 0;
      for (let index = 0; index < position.line; index += 1) {
        offset += (lines[index] || "").length + 1;
      }
      return offset + position.character;
    }
  };
}

function makeUri(fsPath) {
  return {
    scheme: "file",
    fsPath,
    toString() {
      return `file://${fsPath}`;
    }
  };
}

function makeDiagnostic({ message, line = 1, severity = 0, source = "clangd" }) {
  return {
    message,
    severity,
    source,
    range: {
      start: {
        line: line - 1,
        character: 0
      },
      end: {
        line: line - 1,
        character: 1
      }
    }
  };
}

(async () => {
  for (const entry of tests) {
    try {
      await entry.fn();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      console.error(`not ok - ${entry.name}`);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    }
  }
})();
