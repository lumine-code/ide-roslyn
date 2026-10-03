const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fileURLToPath } = require("node:url");
const { position } = require("./project");

const editsOf = (edit) => [
  ...Object.values(edit.changes || {}).flat(),
  ...(edit.documentChanges || []).flatMap((item) => item.edits || []),
];
const applyEdits = (text, edits) => {
  const offset = ({ line, character }) =>
    text
      .split("\n")
      .slice(0, line)
      .reduce((total, item) => total + item.length + 1, 0) + character;
  return edits
    .map((edit) => ({ ...edit, start: offset(edit.range.start), end: offset(edit.range.end) }))
    .sort((a, b) => b.start - a.start)
    .reduce(
      (value, edit) => value.slice(0, edit.start) + edit.newText + value.slice(edit.end),
      text,
    );
};
const sameFile = (uri, filePath) =>
  uri?.startsWith("file:") && fileURLToPath(uri).toLowerCase() === filePath.toLowerCase();
const flattenSymbols = (symbols) =>
  symbols.flatMap((item) => [item, ...flattenSymbols(item.children || [])]);
const requestAt = (client, fixture, method, fragment, inside = 0, extra = {}) =>
  client.request(method, {
    textDocument: { uri: fixture.uri },
    position: position(fixture.text, fragment, inside),
    ...extra,
  });

const exerciseServer = async (client, fixture) => {
  const covered = [];
  const check = (name, value) => {
    assert.ok(value, `${name} produced no usable result`);
    covered.push(name);
  };
  client.open(fixture.uri, "csharp", fixture.text);
  await client.waitFor(
    () => client.messages("workspace/projectInitializationComplete").length,
    "MSBuild project initialization",
    90000,
  );
  const diagnostics = await client.request("textDocument/diagnostic", {
    textDocument: { uri: fixture.uri },
  });
  const broken = diagnostics.items.find(({ code }) => code === "CS0103");
  check("diagnostics", broken?.message.includes("missingName"));
  check(
    "dynamic diagnostic registration",
    client.registrations.some(({ method }) => method === "textDocument/diagnostic"),
  );
  const completion = await requestAt(client, fixture, "textDocument/completion", "Double(3)", 3);
  const item = (completion.items || completion).find(({ label }) => label === "Double");
  check("completion", item);
  const resolvedItem = await client.request("completionItem/resolve", item);
  check("completion resolve", JSON.stringify(resolvedItem).includes("twice"));
  const hover = await requestAt(client, fixture, "textDocument/hover", "Double(3)", 1);
  check("hover", JSON.stringify(hover).includes("Calculator.Double"));
  const signature = await requestAt(client, fixture, "textDocument/signatureHelp", "Double(3)", 7);
  check(
    "signature",
    signature.signatures.some(({ label }) => label.includes("int value")),
  );
  const definitions = await requestAt(client, fixture, "textDocument/definition", "Double(3)", 1);
  check(
    "definition",
    definitions.some((item) => sameFile(item.uri || item.targetUri, fixture.filePath)),
  );
  const external = await requestAt(client, fixture, "textDocument/definition", "Triple(3)", 1);
  check(
    "project reference definition",
    external.some((item) => sameFile(item.uri || item.targetUri, fixture.supportPath)),
  );
  const metadata = await requestAt(client, fixture, "textDocument/definition", "ToUpper()", 1);
  check(
    "metadata definition",
    metadata.some((item) => {
      const uri = item.uri || item.targetUri;
      return (
        uri?.startsWith("file:") &&
        fs.existsSync(fileURLToPath(uri)) &&
        fs.readFileSync(fileURLToPath(uri), "utf8").includes("ToUpper")
      );
    }),
  );
  const references = await requestAt(client, fixture, "textDocument/references", "Double(int", 1, {
    context: { includeDeclaration: true },
  });
  check("references", references.length >= 2);
  const rename = await requestAt(client, fixture, "textDocument/rename", "Double(3)", 1, {
    newName: "Twice",
  });
  const renamed = applyEdits(fixture.text, editsOf(rename));
  check(
    "UTF-16 rename edits",
    renamed.includes('"😀"; var result = Twice(3)') &&
      renamed.includes("int Twice(int value)") &&
      !renamed.includes("Double"),
  );
  const symbols = await client.request("textDocument/documentSymbol", {
    textDocument: { uri: fixture.uri },
  });
  check(
    "document symbols",
    flattenSymbols(symbols).some(({ name }) => name.startsWith("Double(")),
  );
  const workspaceSymbols = await client.request("workspace/symbol", { query: "Double" });
  check(
    "workspace symbols",
    workspaceSymbols.some(({ name }) => name === "Double"),
  );
  const formatting = await client.request("textDocument/formatting", {
    textDocument: { uri: fixture.uri },
    options: { tabSize: 4, insertSpaces: true },
  });
  const formatted = applyEdits(fixture.text, formatting);
  check(
    "formatting edits",
    formatting.length > 0 && formatted.includes("    public int Add") && formatted.includes("😀"),
  );
  const actions = await client.request("textDocument/codeAction", {
    textDocument: { uri: fixture.uri },
    range: broken.range,
    context: { diagnostics: [broken], only: ["quickfix"] },
  });
  const action = actions.find(({ title }) => title.includes("Generate method 'missingName'"));
  check("code actions", action);
  const resolved = await client.request("codeAction/resolve", action);
  check(
    "code action edits",
    applyEdits(fixture.text, editsOf(resolved.edit)).includes("void missingName()"),
  );
  const range = {
    start: { line: 0, character: 0 },
    end: { line: fixture.text.split("\n").length - 1, character: 0 },
  };
  const hints = await client.request("textDocument/inlayHint", {
    textDocument: { uri: fixture.uri },
    range,
  });
  check("inlay hints", hints.length > 0 && JSON.stringify(hints).includes("value"));
  if (hints[0].data)
    check("inlay hint resolve", await client.request("inlayHint/resolve", hints[0]));
  const tokens = await client.request("textDocument/semanticTokens/full", {
    textDocument: { uri: fixture.uri },
  });
  check("semantic tokens", tokens.data.length > 0 && tokens.data.length % 5 === 0);
  const functions = await requestAt(
    client,
    fixture,
    "textDocument/prepareCallHierarchy",
    "Double(int",
    1,
  );
  const incoming = await client.request("callHierarchy/incomingCalls", { item: functions[0] });
  check(
    "incoming calls",
    incoming.some(({ from }) => from.name.includes("Use")),
  );
  const caller = await requestAt(client, fixture, "textDocument/prepareCallHierarchy", "Use()", 1);
  const outgoing = await client.request("callHierarchy/outgoingCalls", { item: caller[0] });
  check(
    "outgoing calls",
    outgoing.some(({ to }) => to.name.includes("Double")),
  );
  const types = await requestAt(
    client,
    fixture,
    "textDocument/prepareTypeHierarchy",
    "IAdder {",
    1,
  );
  const subtypes = await client.request("typeHierarchy/subtypes", { item: types[0] });
  check(
    "type subtypes",
    subtypes.some(({ name }) => name === "Calculator"),
  );
  const concrete = await requestAt(
    client,
    fixture,
    "textDocument/prepareTypeHierarchy",
    "Calculator :",
    1,
  );
  const supertypes = await client.request("typeHierarchy/supertypes", { item: concrete[0] });
  check(
    "type supertypes",
    supertypes.some(({ name }) => name === "IAdder"),
  );
  const lenses = await client.request("textDocument/codeLens", {
    textDocument: { uri: fixture.uri },
  });
  const lens = await client.request("codeLens/resolve", lenses[0]);
  check(
    "client-only code lens identified",
    lens.command?.command === "roslyn.client.peekReferences",
  );
  const replacement = fixture.text.replace("missingName()", "Double(1)");
  await client.connection.sendNotification("textDocument/didChange", {
    textDocument: { uri: fixture.uri, version: 2 },
    contentChanges: [{ text: replacement }],
  });
  const repaired = await client.request("textDocument/diagnostic", {
    textDocument: { uri: fixture.uri },
  });
  check("diagnostics after change", !repaired.items.some(({ code }) => code === "CS0103"));
  return covered;
};
module.exports = { exerciseServer, applyEdits, editsOf, sameFile, flattenSymbols };
