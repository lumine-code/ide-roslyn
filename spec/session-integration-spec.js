const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProject, prepareProject, position, removeProject } = require("./helpers/project");
const { serverPath, dotnetPath, liveSuite } = require("./helpers/environment");
const { sameFile } = require("./helpers/exercise-server");
const until = async (check, label) => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`${label} timed out`);
};

liveSuite("ide-roslyn real editor integration", () => {
  let rootPath, editor, previousPaths, timeout, service, diagnostics, diagnosticEdge;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 180000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    previousPaths = lumine.project.getPaths();
    rootPath = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-roslyn-editor-"));
    for (const [key, value] of Object.entries({
      serverPath,
      dotnetPath,
      parameterHints: "enabled",
      typeHints: "enabled",
    }))
      lumine.config.set(`ide-roslyn.${key}`, value);
    for (const name of ["language-csharp", "ide", "ide-roslyn"])
      await lumine.packages.activatePackage(name);
    service = lumine.packages.getActivePackage("ide").mainModule.provideIde();
    diagnostics = [];
    diagnosticEdge = service.onDidPublishDiagnostics((event) => diagnostics.push(event));
  });
  afterEach(async () => {
    diagnosticEdge?.dispose();
    editor?.destroy();
    for (const name of ["ide-roslyn", "ide", "language-csharp"])
      await lumine.packages.deactivatePackage(name);
    for (const key of [
      "serverPath",
      "dotnetPath",
      "parameterHints",
      "typeHints",
      "features.format",
      "features.hover",
      "features.diagnostics",
    ])
      lumine.config.unset(`ide-roslyn.${key}`);
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    await removeProject(rootPath);
    editor = null;
  });
  it("routes language features, applies Unicode workspace edits and reattaches after unload", async () => {
    const fixture = createProject(rootPath);
    await prepareProject(fixture, dotnetPath);
    lumine.project.setPaths([rootPath]);
    editor = await lumine.workspace.open(fixture.filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.cs"));
    const session = await until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-roslyn",
        ),
      "Roslyn editor session",
    );
    await until(
      () =>
        diagnostics.some(
          ({ diagnostics: items }) =>
            items.some(({ code }) => code === "CS0103") &&
            items.some(({ code }) => code === "IDE0059"),
        ),
      "compiler and analyzer diagnostics aggregated from independent pull providers",
    );
    const main = lumine.packages.getActivePackage("ide").mainModule;
    const Point = require("lumine").Point;
    const at = (fragment, inside = 0) => {
      const p = position(editor.getText(), fragment, inside);
      return new Point(p.line, p.character);
    };
    const rawHover = await session.request("textDocument/hover", {
      textDocument: { uri: fixture.uri },
      position: position(editor.getText(), "Double(3)", 1),
    });
    expect(JSON.stringify(rawHover)).toContain("Calculator.Double");
    if (!session.supports("textDocument/hover", editor))
      throw new Error(
        `C# hover routing suppressed despite static capability ${session.capabilities.hoverProvider}; registrations: ${JSON.stringify([...session.manager.dynamicCapabilities.get(session).values()].filter(({ method }) => method === "textDocument/hover"))}`,
      );
    const suggestions = await main.provideAutocomplete().getSuggestions({
      editor,
      bufferPosition: at("Double(3)", 3),
      prefix: "Dou",
      activatedManually: true,
    });
    expect(
      suggestions.some((item) =>
        (item.displayText || item.text || item.snippet || "").includes("Double"),
      ),
    ).toBe(true);
    expect(
      (await main.provideContextHelp().getHelp(editor, at("Double(3)", 1))).contents.value,
    ).toContain("Calculator.Double");
    expect(
      (await main.provideHoverSignature().getSignature(editor, at("Double(3)", 7))).signatures[0]
        .label,
    ).toContain("int value");
    const documentProvider = main.provideDocumentSymbolProvider();
    const source = documentProvider
      .getDocumentSymbolSources(editor)
      .find(({ id }) => id === "ide:ide-roslyn");
    expect(source.state).toBe("ready");
    const symbols = await documentProvider.getDocumentSymbols(editor, { sourceId: source.id });
    expect(symbols.some(({ name }) => name.startsWith("Double("))).toBe(true);
    const projectSymbols = await main
      .provideWorkspaceSymbolProvider()
      .searchWorkspaceSymbols("Double");
    expect(projectSymbols.some(({ name }) => name === "Double")).toBe(true);
    editor.setCursorBufferPosition(at("Triple(3)", 1));
    const definitions = await main.provideDefinitionProvider().getDefinitions(editor);
    expect(
      definitions.some(
        ({ path: target }) => target?.toLowerCase() === fixture.supportPath.toLowerCase(),
      ),
    ).toBe(true);
    editor.setCursorBufferPosition(at("Double(3)", 1));
    const references = await main
      .provideFindReferences()
      .findReferences(editor, at("Double(3)", 1));
    expect(references.references.length).toBeGreaterThanOrEqual(2);
    const hints = await main.provideInlayHints().inlayHints(editor, [0, editor.getLastBufferRow()]);
    expect(hints.some(({ label }) => label.includes("value"))).toBe(true);
    const tokens = await main
      .provideSemanticTokens()
      .semanticTokensInRange(editor, [0, editor.getLastBufferRow()]);
    expect(tokens.length).toBeGreaterThan(0);
    expect(session.supports("textDocument/codeLens", editor)).toBe(false);
    const intentions = await main
      .provideIntentionsList()
      .getIntentions({ textEditor: editor, bufferPosition: at("missingName()", 1) });
    expect(intentions.some(({ title }) => title.includes("Generate method 'missingName'"))).toBe(
      true,
    );
    expect(intentions.some(({ title }) => title.startsWith("Fix All:"))).toBe(false);
    const rename = await main
      .provideRefactor()
      .rename(editor, at("Double(3)", 1), "Twice", { dryRun: true });
    expect(rename.outcome).toBe("edits");
    const renameEdits = [...rename.edits.values()].flat();
    const uri = fixture.uri;
    const applied = await service.applyWorkspaceEdit(
      {
        changes: {
          [uri]: renameEdits.map(({ oldRange, newText }) => ({
            range: {
              start: { line: oldRange[0][0], character: oldRange[0][1] },
              end: { line: oldRange[1][0], character: oldRange[1][1] },
            },
            newText,
          })),
        },
      },
      "Rename C# symbol",
      session,
    );
    expect(applied).toBe(true);
    expect(editor.getText()).toContain('"😀"; var result = Twice(3)');
    expect(editor.getText()).toContain("int Twice(int value)");
    const generated = intentions.find(({ title }) =>
      title.includes("Generate method 'missingName'"),
    );
    // Re-query after the rename: the code action's resolve data belongs to the
    // old document generation and must never be reused after a buffer edit.
    expect(generated).toBeTruthy();
    const refreshed = await main
      .provideIntentionsList()
      .getIntentions({ textEditor: editor, bufferPosition: at("missingName()", 1) });
    await refreshed.find(({ title }) => title.includes("Generate method 'missingName'")).selected();
    expect(editor.getText()).toContain("void missingName()");
    expect(editor.getText()).toContain("😀");
    await until(() => {
      const items = diagnostics
        .filter(({ session: owner, uri }) => owner === session && sameFile(uri, fixture.filePath))
        .at(-1)?.diagnostics;
      return (
        items &&
        !items.some(({ code }) => code === "CS0103") &&
        items.some(({ code }) => code === "IDE0059")
      );
    }, "compiler diagnostic cleared while unchanged analyzer diagnostics survive");
    const provider = main.provideCodeFormatFile();
    expect((await provider.formatEntireFile(editor)).length).toBeGreaterThan(0);
    for (const [feature, method] of [
      ["autocomplete", "textDocument/completion"],
      ["signature", "textDocument/signatureHelp"],
      ["definition", "textDocument/definition"],
      ["references", "textDocument/references"],
      ["symbols", "textDocument/documentSymbol"],
      ["rename", "textDocument/rename"],
      ["codeActions", "textDocument/codeAction"],
      ["inlayHints", "textDocument/inlayHint"],
      ["semanticTokens", "textDocument/semanticTokens"],
      ["callHierarchy", "textDocument/prepareCallHierarchy"],
      ["typeHierarchy", "textDocument/prepareTypeHierarchy"],
      ["diagnostics", "textDocument/diagnostic"],
    ]) {
      lumine.config.set(`ide-roslyn.features.${feature}`, false);
      expect(await service.activeSessionForFeature(editor, method)).toBeNull();
      lumine.config.unset(`ide-roslyn.features.${feature}`);
      expect(await service.activeSessionForFeature(editor, method)).toBe(session);
    }
    lumine.config.set("ide-roslyn.features.format", false);
    expect(await service.activeSessionForFeature(editor, "textDocument/formatting")).toBeNull();
    expect(await provider.formatEntireFile(editor)).toBeNull();
    lumine.config.set("ide-roslyn.features.hover", false);
    expect(await main.provideContextHelp().getHelp(editor, at("Twice(3)", 1))).toBeNull();
    lumine.config.set("ide-roslyn.features.hover", true);
    expect(
      (
        await until(async () => {
          const value = await main.provideContextHelp().getHelp(editor, at("Twice(3)", 1));
          return value?.contents.value.includes("Twice") ? value : null;
        }, "hover after feature re-enabling")
      ).contents.value,
    ).toContain("Twice");
    await lumine.packages.deactivatePackage("ide-roslyn");
    await until(() => session.state === "stopped", "Roslyn process teardown");
    expect(service.adaptersForEditor(editor)).toEqual([]);
    const previous = lumine.packages.getLoadedPackage("ide-roslyn").mainModule;
    await lumine.packages.unloadPackage("ide-roslyn");
    lumine.packages.loadPackage("ide-roslyn");
    const pkg = await lumine.packages.activatePackage("ide-roslyn");
    expect(pkg.mainModule).not.toBe(previous);
    const replacement = await until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-roslyn",
        ),
      "fresh Roslyn generation",
    );
    expect(replacement).not.toBe(session);
    expect(
      (
        await until(async () => {
          const value = await main.provideContextHelp().getHelp(editor, at("Twice(3)", 1));
          return value?.contents.value.includes("Twice") ? value : null;
        }, "hover after package reload")
      ).contents.value,
    ).toContain("Twice");
  });
});
