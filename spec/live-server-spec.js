const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, prepareProject, removeProject } = require("./helpers/project");
const { exerciseServer } = require("./helpers/exercise-server");
const { serverPath, dotnetPath, liveSuite } = require("./helpers/environment");

liveSuite("ide-roslyn real Roslyn protocol", () => {
  let rootPath, client, edge, timeout, main;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 180000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    rootPath = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-roslyn-live-"));
    main = (await lumine.packages.activatePackage("ide-roslyn")).mainModule;
    for (const [key, value] of Object.entries({
      serverPath,
      dotnetPath,
      parameterHints: "enabled",
      typeHints: "enabled",
    }))
      lumine.config.set(`ide-roslyn.${key}`, value);
    edge = main.consumeIdeClient({
      registerAdapter(adapter) {
        client = new LiveLspClient(adapter, rootPath);
        return { dispose() {} };
      },
      reportMissingServer() {},
    });
  });
  afterEach(async () => {
    await client.stop();
    edge.dispose();
    for (const key of ["serverPath", "dotnetPath", "parameterHints", "typeHints"])
      lumine.config.unset(`ide-roslyn.${key}`);
    await lumine.packages.deactivatePackage("ide-roslyn");
    await lumine.packages.deactivatePackage("ide-client");
    await removeProject(rootPath);
  });
  it("serves compiler diagnostics, every supported language feature and project references", async () => {
    const fixture = createProject(rootPath);
    await prepareProject(fixture, dotnetPath);
    const { serverInfo } = await client.start();
    expect(serverInfo.name).toBe("CSharpVisualBasicLanguageServerFactory");
    const covered = await exerciseServer(client, fixture);
    expect(covered.length).toBeGreaterThanOrEqual(25);
    expect(covered).toContain("UTF-16 rename edits");
    expect(covered).toContain("project reference definition");
  });
  it("downloads the verified official NuGet package and runs its managed DLL", async () => {
    const fixture = createProject(rootPath);
    await prepareProject(fixture, dotnetPath);
    await lumine.packages.activatePackage("ide-client");
    const service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
    const ManagedServers = require(
      path.join(lumine.packages.getActivePackage("ide-client").path, "lib", "managed-servers"),
    );
    const InstallApi = require(
      path.join(lumine.packages.getActivePackage("ide-client").path, "lib", "install-api"),
    );
    const storagePath = path.join(rootPath, "managed");
    const managed = new ManagedServers({}, { storageRoot: storagePath });
    const adapter = { id: "ide-roslyn" };
    const server = require("../lib/server");
    const installed = await server.installServer({
      storagePath,
      version: process.env.ROSLYN_VERSION || "5.12.0-1.26475.2",
      api: new InstallApi(managed, adapter),
    });
    expect(installed.source).toBe("nuget");
    expect(installed.checksum).toMatch(/^sha512:[0-9a-f]{128}$/);
    expect(
      fs.existsSync(
        path.join(storagePath, "tools", "net10.0", server.packageFor().target, "BuildHost-netcore"),
      ),
    ).toBe(true);
    lumine.config.set("ide-roslyn.serverPath", "");
    const { serverInfo } = await client.start({
      modulePath: path.join(storagePath, installed.module),
      version: installed.version,
    });
    expect(serverInfo.name).toBe("CSharpVisualBasicLanguageServerFactory");
    const covered = await exerciseServer(client, fixture);
    expect(covered).toContain("code action edits");
    expect(service).toBeTruthy();
    await lumine.packages.deactivatePackage("ide-client");
    managed.emitter.dispose();
  });
});
