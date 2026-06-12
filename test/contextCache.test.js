const assert = require("assert").strict;
const { FimClient } = require("../src/api/fimClient");
const { buildFimPrompt } = require("../src/api/fimPrompt");
const { CompletionPostProcessor } = require("../src/completion/completionPostProcessor");
const { InlineCompletionProvider } = require("../src/completion/inlineCompletionProvider");
const { RelatedFileSelector } = require("../src/completion/relatedFileSelector");
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

test("IncludeAssist marks include mode and builds a deterministic missing include completion", () => {
  const assist = new IncludeAssist();
  const document = makeDocument({
    text: [
      "#include <string>",
      "",
      "void use() {",
      "  std::vector<int> values;",
      "}",
      ""
    ].join("\n"),
    languageId: "cpp"
  });
  const position = { line: 1, character: 0 };
  const missingStandardIncludes = assist.inferMissingStandardIncludes({
    document,
    position,
    diagnostics: [
      makeDiagnostic({
        message: "no template named 'vector' in namespace 'std'",
        line: 4,
        severity: 0
      })
    ]
  });
  const mode = assist.getIncludeCompletionMode({
    document,
    position,
    missingStandardIncludes,
    missingProjectIncludes: []
  });
  const completion = assist.buildPreferredIncludeCompletion({
    document,
    position,
    mode,
    missingStandardIncludes,
    missingProjectIncludes: []
  });

  assert.equal(mode.cursorInIncludeRegion, true);
  assert.equal(mode.cursorOnBlankLineInIncludeRegion, true);
  assert.equal(mode.missingIncludeDiagnosticAfterCursor, true);
  assert.equal(completion.text, "#include <vector>\n");
});

test("IncludeAssist completes standard and local include prefixes", () => {
  const assist = new IncludeAssist();
  const standardDocument = makeDocument({
    text: "#include <vec",
    languageId: "cpp"
  });
  const standardPosition = { line: 0, character: "#include <vec".length };
  const standardMode = assist.getIncludeCompletionMode({
    document: standardDocument,
    position: standardPosition,
    missingStandardIncludes: [],
    missingProjectIncludes: []
  });
  const standardCompletion = assist.buildPreferredIncludeCompletion({
    document: standardDocument,
    position: standardPosition,
    mode: standardMode,
    standardHeaderCandidates: assist.getStandardHeaderPrefixCandidates("vec"),
    localHeaderCandidates: []
  });

  const localDocument = makeDocument({
    text: "#include \"pack",
    languageId: "cpp"
  });
  const localPosition = { line: 0, character: "#include \"pack".length };
  const localMode = assist.getIncludeCompletionMode({
    document: localDocument,
    position: localPosition,
    missingStandardIncludes: [],
    missingProjectIncludes: []
  });
  const localCompletion = assist.buildPreferredIncludeCompletion({
    document: localDocument,
    position: localPosition,
    mode: localMode,
    standardHeaderCandidates: [],
    localHeaderCandidates: [
      {
        includeText: "memory/packet_buffer.hpp",
        headerUri: makeUri("/repo/include/memory/packet_buffer.hpp")
      }
    ]
  });

  assert.equal(standardCompletion.text, "tor>");
  assert.equal(localCompletion.text, "memory/packet_buffer.hpp\"");
  assert.deepEqual(localCompletion.replaceRange, {
    start: {
      line: 0,
      character: "#include \"".length
    },
    end: localPosition
  });
});

test("IncludeAssist does not treat a complete include line as an insertion point", () => {
  const assist = new IncludeAssist();
  const document = makeDocument({
    text: [
      "#include <string>",
      "",
      "void use() {",
      "  std::vector<int> values;",
      "}",
      ""
    ].join("\n"),
    languageId: "cpp"
  });
  const position = { line: 0, character: "#include <string>".length };
  const missingStandardIncludes = assist.inferMissingStandardIncludes({
    document,
    position,
    diagnostics: [
      makeDiagnostic({
        message: "no template named 'vector' in namespace 'std'",
        line: 4,
        severity: 0
      })
    ]
  });
  const mode = assist.getIncludeCompletionMode({
    document,
    position,
    missingStandardIncludes,
    missingProjectIncludes: []
  });

  assert.equal(mode.cursorInIncludeRegion, true);
  assert.equal(mode.cursorInsideIncludeDirective, false);
  assert.equal(assist.buildPreferredIncludeCompletion({
    document,
    position,
    mode,
    missingStandardIncludes,
    missingProjectIncludes: []
  }), undefined);
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

test("FimClient sends long suffix lines as provider stop sequences", () => {
  const client = new FimClient({
    defaultBaseUrl: "https://openai.test",
    defaultAnthropicBaseUrl: "https://anthropic.test"
  });
  const context = {
    suffix: [
      "  const auto serializedResponse = serializeResponse(response, options);",
      "  writer.write(serializedResponse);",
      "}"
    ].join("\n"),
    metadata: {
      lineSuffix: ""
    }
  };
  const config = {
    temperature: 0.1,
    maxOutputTokens: 64,
    sendThinkingDisabled: false
  };
  const openAiRequest = client.buildOpenAiRequest(
    { apiKey: "key", model: "model", baseUrl: "https://api.test/v1" },
    context,
    config
  );
  const anthropicRequest = client.buildAnthropicRequest(
    { apiKey: "key", model: "model", baseUrl: "https://anthropic.test/v1" },
    context,
    config
  );

  assert.deepEqual(openAiRequest.body.stop, [
    "  const auto serializedResponse = serializeResponse(response, options);",
    "  writer.write(serializedResponse);"
  ]);
  assert.deepEqual(anthropicRequest.body.stop_sequences, openAiRequest.body.stop);
});

test("buildFimPrompt orders stable and dynamic sections without cursor coordinates", () => {
  const prompt = buildFimPrompt({
    projectProfile: "C++ project using compact inline completions.",
    cachedContextSections: [
      "Current file diagnostics near cursor:\n- Error clangd line 7: no member named value"
    ],
    extraContext: "// Related context\nvoid helper();",
    prefix: "int main() {\n  ",
    suffix: "\n}",
    metadata: {
      languageId: "cpp",
      fileName: "main.cpp",
      line: 42,
      character: 9,
      cursorComment: {
        inside: false
      }
    }
  });
  const orderedMarkers = [
    "Fill the cursor gap using FIM.",
    "<project_profile>",
    "<workspace_strategy>",
    "<metadata>",
    "<diagnostics_context>",
    "<extra_context>",
    "<fim_prefix>",
    "<fim_suffix>"
  ];
  const positions = orderedMarkers.map((marker) => prompt.indexOf(marker));

  for (const position of positions) {
    assert.notEqual(position, -1);
  }

  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index - 1] < positions[index]);
  }

  assert.match(prompt, /Language: cpp/);
  assert.match(prompt, /File: main\.cpp/);
  assert.equal(prompt.includes("Cursor: line"), false);
  assert.equal(prompt.includes("line 42"), false);
  assert.equal(prompt.includes("column 9"), false);
});

test("CompletionPostProcessor removes repeated prefix blocks", () => {
  const processor = new CompletionPostProcessor();
  const result = processor.process({
    raw: [
      "  const auto renderedValue = renderValue(input, options, diagnostics);",
      "  sink(renderedValue);",
      "  return renderedValue;"
    ].join("\n"),
    context: {
      prefix: [
        "void render() {",
        "  const auto renderedValue = renderValue(input, options, diagnostics);",
        "  sink(renderedValue);"
      ].join("\n"),
      suffix: "",
      metadata: {
        linePrefix: "",
        lineSuffix: "",
        indentation: ""
      }
    },
    config: {
      maxCompletionLines: 8,
      maxOutputTokens: 128
    }
  });

  assert.equal(result, "  return renderedValue;");
});

test("CompletionPostProcessor truncates repeated suffix blocks", () => {
  const processor = new CompletionPostProcessor();
  const result = processor.process({
    raw: [
      "auto response = buildResponse(request);",
      "  const auto serializedResponse = serializeResponse(response, options);",
      "  writer.write(serializedResponse);",
      "}"
    ].join("\n"),
    context: {
      prefix: "",
      suffix: [
        "  const auto serializedResponse = serializeResponse(response, options);",
        "  writer.write(serializedResponse);",
        "}"
      ].join("\n"),
      metadata: {
        linePrefix: "",
        lineSuffix: "",
        indentation: ""
      }
    },
    config: {
      maxCompletionLines: 8,
      maxOutputTokens: 128
    }
  });

  assert.equal(result, "auto response = buildResponse(request);");
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

test("LocalHeaderIndex looks up headers by include path or basename prefix", async () => {
  const packetUri = makeUri("/repo/include/memory/packet_buffer.hpp");
  const workerUri = makeUri("/repo/include/runtime/worker.hpp");
  const vscode = makeVscode({
    fileText(uriToRead) {
      if (uriToRead.toString() === packetUri.toString()) {
        return "";
      }
      if (uriToRead.toString() === workerUri.toString()) {
        return "struct Worker {};";
      }
      return "";
    }
  });
  const index = new LocalHeaderIndex({ vscode });

  await index.refreshFile(packetUri);
  await index.refreshFile(workerUri);

  assert.equal(index.lookupIncludePrefix("memory/pack")[0].includeText, "memory/packet_buffer.hpp");
  assert.equal(index.lookupIncludePrefix("worker")[0].includeText, "runtime/worker.hpp");
});

test("LocalHeaderIndex removeFile keeps same-name symbols from other headers", async () => {
  const firstUri = makeUri("/repo/include/a/packet.hpp");
  const secondUri = makeUri("/repo/include/b/packet.hpp");
  const vscode = makeVscode({
    fileText(uriToRead) {
      if (uriToRead.toString() === firstUri.toString()) {
        return "struct Packet {};";
      }
      if (uriToRead.toString() === secondUri.toString()) {
        return "struct Packet {};";
      }
      return "";
    }
  });
  const index = new LocalHeaderIndex({ vscode });

  await index.refreshFile(firstUri);
  await index.refreshFile(secondUri);
  assert.equal(index.lookupSymbol("Packet").length, 2);

  index.removeFile(firstUri);
  const remaining = index.lookupSymbol("Packet");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].includeText, "b/packet.hpp");
});

test("LocalHeaderIndex excludes wildcard build directories on incremental refresh", () => {
  const index = new LocalHeaderIndex({ vscode: makeVscode() });
  assert.equal(index.isExcluded(makeUri("/repo/cmake-build-debug/generated.hpp")), true);
});

test("RelatedFileSelector reads an open related document once", () => {
  const currentDocument = makeDocument({
    uri: makeUri("/repo/src/main.cpp"),
    text: "void use(PacketBufferMeta value);",
    languageId: "cpp"
  });
  let readCount = 0;
  const relatedDocument = {
    uri: makeUri("/repo/include/memory/packet_buffer.hpp"),
    languageId: "cpp",
    getText() {
      readCount += 1;
      return [
        "#pragma once",
        "namespace memory {",
        "struct PacketBufferMeta {};",
        "}",
        ""
      ].join("\n");
    }
  };
  const selector = new RelatedFileSelector({
    vscode: makeVscode({
      textDocuments: [currentDocument, relatedDocument]
    })
  });
  const candidates = [];

  selector.addOpenDocumentCandidates(candidates, currentDocument, ["PacketBufferMeta"], {
    maxRelatedFileBytes: 262144
  });

  assert.equal(readCount, 1);
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].text, /PacketBufferMeta/);
});

test("WorkspaceContextCache exposes deterministic include completion for diagnostics after cursor", async () => {
  const uri = makeUri("/repo/src/main.cpp");
  const vscode = makeVscode({
    diagnostics: new Map([
      [uri.toString(), [
        makeDiagnostic({
          message: "no template named 'vector' in namespace 'std'",
          line: 4,
          severity: 0
        })
      ]]
    ])
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
  const document = makeDocument({
    uri,
    text: [
      "#include <string>",
      "",
      "void use() {",
      "  std::vector<int> values;",
      "}",
      ""
    ].join("\n"),
    languageId: "cpp"
  });

  const snapshot = await cache.buildSnapshot(
    document,
    { line: 1, character: 0 },
    { isCancellationRequested: false }
  );

  assert.equal(snapshot.includeCompletion.text, "#include <vector>\n");
  assert.equal(snapshot.includeCompletionMode.missingIncludeDiagnosticAfterCursor, true);
});

test("InlineCompletionProvider allows automatic completion on blank include-region lines", () => {
  const document = makeDocument({
    text: [
      "#include <string>",
      "",
      "int main();",
      ""
    ].join("\n"),
    languageId: "cpp"
  });
  const position = { line: 1, character: 0 };
  const vscode = makeVscode({
    activeTextEditor: {
      document,
      selection: {
        isEmpty: true,
        active: position
      }
    }
  });
  const provider = new InlineCompletionProvider({
    vscode,
    output: makeOutput(),
    readRuntimeConfig() {
      return {};
    },
    workspaceContextCache: {
      isIncludeCompletionPosition() {
        return true;
      }
    }
  });

  assert.equal(provider.canProvide(
    document,
    position,
    { triggerKind: vscode.InlineCompletionTriggerKind.Automatic },
    { isCancellationRequested: false },
    { enabled: true }
  ), true);
});

test("InlineCompletionProvider skips remote FIM when FIM is disabled", async () => {
  const text = "const value = ";
  const document = makeDocument({
    text,
    languageId: "javascript"
  });
  const position = { line: 0, character: text.length };
  const vscode = makeVscode({
    activeTextEditor: {
      document,
      selection: {
        isEmpty: true,
        active: position
      }
    }
  });
  const provider = new InlineCompletionProvider({
    vscode,
    output: makeOutput(),
    readRuntimeConfig() {
      return {
        apiKey: "key",
        fimEnabled: false
      };
    },
    workspaceContextCache: {
      async buildSnapshot() {
        return { promptSections: [] };
      }
    }
  });
  let contextBuilderCalled = false;
  let fimClientCalled = false;
  provider.contextBuilder = {
    async build() {
      contextBuilderCalled = true;
      return {};
    }
  };
  provider.fimClient = {
    async complete() {
      fimClientCalled = true;
      return "completion";
    }
  };

  const result = await provider.provideInlineCompletionItems(
    document,
    position,
    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke },
    { isCancellationRequested: false }
  );

  assert.equal(result, undefined);
  assert.equal(contextBuilderCalled, false);
  assert.equal(fimClientCalled, false);
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
    InlineCompletionTriggerKind: {
      Automatic: 0,
      Invoke: 1
    },
    InlineCompletionItem: class InlineCompletionItem {
      constructor(insertText, range) {
        this.insertText = insertText;
        this.range = range;
      }
    },
    Range: class Range {
      constructor(startOrLine, startCharacterOrEnd, endLine, endCharacter) {
        if (typeof startOrLine === "number") {
          this.start = {
            line: startOrLine,
            character: startCharacterOrEnd
          };
          this.end = {
            line: endLine,
            character: endCharacter
          };
          return;
        }

        this.start = startOrLine;
        this.end = startCharacterOrEnd;
      }
    },
    SymbolKind: {
      Namespace: 3,
      Class: 4,
      Enum: 10,
      Interface: 11,
      Struct: 22,
      TypeAlias: 25
    },
    window: {
      activeTextEditor: options.activeTextEditor
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
      textDocuments: options.textDocuments || [],
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

function makeOutput() {
  return {
    appendLine() {}
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
