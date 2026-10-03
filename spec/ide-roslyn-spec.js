const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { removeProject } = require("./helpers/project");

describe("ide-roslyn adapter and NuGet management", () => {
  let main, server, adapter, edge, changed, scratch;
  const configure = (name, value) => {
    changed.add(name);
    lumine.config.set(`ide-roslyn.${name}`, value);
  };
  const register = () => {
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: jasmine.createSpy("dispose") };
      },
      reportMissingServer: jasmine.createSpy("missing"),
    });
  };
  beforeEach(async () => {
    jasmine.useRealClock();
    main = (await lumine.packages.activatePackage("ide-roslyn")).mainModule;
    server = require("../lib/server");
    changed = new Set();
    scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-roslyn-unit-"));
    register();
  });
  afterEach(async () => {
    edge?.dispose();
    for (const key of changed) lumine.config.unset(`ide-roslyn.${key}`);
    await lumine.packages.deactivatePackage("ide-roslyn");
    await removeProject(scratch);
  });
  it("returns the provider edge disposable and registers the C# grammar", () => {
    expect(edge.dispose).not.toHaveBeenCalled();
    expect(adapter.id).toBe("ide-roslyn");
    expect(adapter.grammarScopes).toEqual(["source.cs"]);
    expect(adapter.languageId).toBe("csharp");
    expect(adapter.sessionScope).toBe("project-root");
    expect(adapter.installServer).toBe(server.installServer);
    expect(adapter.managedServer).toBeUndefined();
    expect(adapter.restartKeyPaths).toEqual(["ide-roslyn.serverPath", "ide-roslyn.dotnetPath"]);
  });
  it("owns one useful tip and independent provider edges", () => {
    const first = { dispose: jasmine.createSpy("first") },
      second = { dispose: jasmine.createSpy("second") };
    expect(main.consumeIdeClient({ registerAdapter: () => first })).toBe(first);
    expect(main.consumeIdeClient({ registerAdapter: () => second })).toBe(second);
    first.dispose();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(main.provideBackgroundTips().packageName).toBe("ide-roslyn");
    expect(main.provideBackgroundTips().tips.length).toBe(1);
  });
  it("reacquires the current generation after awaited unload and reload", async () => {
    const previous = main;
    edge.dispose();
    await lumine.packages.deactivatePackage("ide-roslyn");
    await lumine.packages.unloadPackage("ide-roslyn");
    lumine.packages.loadPackage("ide-roslyn");
    main = (await lumine.packages.activatePackage("ide-roslyn")).mainModule;
    server = require("../lib/server");
    register();
    expect(main).not.toBe(previous);
    expect(adapter.installServer).toBe(server.installServer);
  });
  it("preserves Roslyn defaults and reads only supported option sections", () => {
    expect(adapter.getSettings()).toEqual({});
    expect(
      adapter.getWorkspaceConfiguration(
        "csharp|inlay_hints.dotnet_enable_inlay_hints_for_parameters",
      ),
    ).toBeUndefined();
    expect(adapter.getWorkspaceConfiguration("editor")).toBeUndefined();
    configure("parameterHints", "enabled");
    configure("typeHints", "disabled");
    expect(
      adapter.getWorkspaceConfiguration(
        "csharp|inlay_hints.dotnet_enable_inlay_hints_for_parameters",
      ),
    ).toBe(true);
    expect(
      adapter.getWorkspaceConfiguration("csharp|inlay_hints.csharp_enable_inlay_hints_for_types"),
    ).toBe(false);
    expect(
      adapter.getWorkspaceConfiguration(
        "visual_basic|inlay_hints.dotnet_enable_inlay_hints_for_parameters",
      ),
    ).toBeUndefined();
  });
  it("does not expose code lenses that require unavailable client commands", () => {
    expect(adapter.isFeatureAvailable("codeLens")).toBe(false);
    expect(adapter.isFeatureAvailable("typeHierarchy")).toBe(true);
    expect(require("../package.json").configSchema.features.properties.codeLens).toBeUndefined();
  });
  it("reports missing servers through the client", async () => {
    const missing = jasmine.createSpy("missing");
    main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return edge;
      },
      reportMissingServer: missing,
    });
    spyOn(server, "resolveServer").and.resolveTo(null);
    expect(await adapter.resolveServer({ rootPath: scratch })).toBeNull();
    expect(missing.calls.argsFor(0)[0]).toBe("ide-roslyn");
    expect(missing.calls.argsFor(0)[1].description).toContain(".NET 10 SDK");
  });
  const validRuntime = () =>
    spyOn(server, "run").and.callFake(async (_command, args) =>
      args[0] === "--list-runtimes"
        ? "Microsoft.NETCore.App 10.0.12 [runtime]\n"
        : "10.0.401 [sdk]\n",
    );
  it("prefers an explicit executable over managed and PATH without changing process environment", async () => {
    validRuntime();
    spyOn(server, "findOnPath");
    const previous = process.env.DOTNET_ROOT;
    const launch = await server.resolveServer(
      process.execPath,
      { binaryPath: "/managed/roslyn" },
      process.execPath,
    );
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["--stdio", "--autoLoadProjects", "--telemetryLevel", "off"]);
    expect(launch.env.DOTNET_HOST_PATH).toBe(process.execPath);
    expect(process.env.DOTNET_ROOT).toBe(previous);
    expect(server.findOnPath).not.toHaveBeenCalled();
  });
  it("launches the managed DLL with the selected dotnet runtime", async () => {
    const modulePath = path.join(scratch, "roslyn.dll");
    fs.writeFileSync(modulePath, "fixture");
    validRuntime();
    spyOn(server, "findOnPath");
    const launch = await server.resolveServer(
      "",
      { modulePath, version: "5.12.0-1.26475.2" },
      process.execPath,
    );
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe(modulePath);
    expect(launch.version).toBe("5.12.0-1.26475.2");
    expect(server.findOnPath).not.toHaveBeenCalled();
  });
  it("discovers PATH only after explicit and managed settings are absent", async () => {
    validRuntime();
    spyOn(server, "findOnPath").and.returnValue(process.execPath);
    expect((await server.resolveServer("", null)).command).toBe(process.execPath);
    expect(server.findOnPath).toHaveBeenCalledWith("roslyn-language-server");
    expect(server.findOnPath).toHaveBeenCalledWith("dotnet");
  });
  it("returns null for no server and never replaces an invalid explicit path", async () => {
    spyOn(server, "findOnPath").and.returnValue(null);
    expect(await server.resolveServer("", null, process.execPath)).toBeNull();
    await expectAsync(
      server.resolveServer(
        path.join(scratch, "absent.dll"),
        { binaryPath: process.execPath },
        process.execPath,
      ),
    ).toBeRejected();
    expect(server.findOnPath.calls.count()).toBe(1);
  });
  it("explains missing runtime and SDK requirements before launching", async () => {
    spyOn(server, "run").and.resolveTo("Microsoft.NETCore.App 8.0.30 [runtime]");
    await expectAsync(
      server.resolveServer(process.execPath, null, process.execPath),
    ).toBeRejectedWithError(/\.NET 10 runtime/);
    server.run.and.callFake(async (_command, args) =>
      args[0] === "--list-runtimes" ? "Microsoft.NETCore.App 10.0.12 [runtime]" : "",
    );
    await expectAsync(
      server.resolveServer(process.execPath, null, process.execPath),
    ).toBeRejectedWithError(/installed .NET SDK/);
  });
  it("derives the runtime root from the real dotnet host and rejects directories", async () => {
    validRuntime();
    const canonical = await fs.promises.realpath(process.execPath);
    const link = path.join(scratch, process.platform === "win32" ? "dotnet.exe" : "dotnet");
    // Test canonical host selection without requiring Windows symlink privileges.
    spyOn(fs.promises, "realpath").and.callFake(async (file) => (file === link ? canonical : file));
    spyOn(fs.promises, "access").and.resolveTo();
    const modulePath = path.join(scratch, "roslyn.dll");
    fs.writeFileSync(modulePath, "fixture");
    const launch = await server.resolveServer(modulePath, null, link);
    expect(launch.command).toBe(canonical);
    expect(launch.env.DOTNET_ROOT).toBe(path.dirname(canonical));
    await expectAsync(server.resolveServer(scratch, null, process.execPath)).toBeRejectedWithError(
      /not a server file/,
    );
  });
  it("finds executable files and ignores missing candidates", () => {
    const name = path.basename(process.execPath, path.extname(process.execPath));
    expect(server.findOnPath(name, { PATH: path.dirname(process.execPath) })).toBe(
      process.execPath,
    );
    expect(server.findOnPath("absent-roslyn", { PATH: scratch })).toBeNull();
  });
  it("launches the chosen official tool's adjacent engine instead of its relay", async () => {
    const relay = path.join(scratch, "roslyn-language-server.dll");
    const engine = path.join(scratch, "Microsoft.CodeAnalysis.LanguageServer.dll");
    fs.writeFileSync(relay, "relay");
    fs.writeFileSync(engine, "engine");
    validRuntime();
    const launch = await server.resolveServer(
      relay,
      { modulePath: "/other/engine.dll" },
      process.execPath,
    );
    expect(launch.args[0]).toBe(engine);
  });
  it("resolves a unique .NET tool payload and refuses to guess between versions", async () => {
    const shim = path.join(
      scratch,
      process.platform === "win32" ? "roslyn-language-server.exe" : "roslyn-language-server",
    );
    fs.writeFileSync(shim, "shim");
    const payload = path.join(scratch, ".store", server.packageFor().name);
    const engine = (version) =>
      path.join(
        payload,
        version,
        "tools",
        "net10.0",
        server.packageFor().target,
        "Microsoft.CodeAnalysis.LanguageServer.dll",
      );
    fs.mkdirSync(path.dirname(engine("5.12.0-1.26475.2")), { recursive: true });
    fs.writeFileSync(engine("5.12.0-1.26475.2"), "engine");
    expect(await server.engineFor(shim)).toBe(engine("5.12.0-1.26475.2"));
    fs.mkdirSync(path.dirname(engine("5.11.0-1.26380.4")), { recursive: true });
    fs.writeFileSync(engine("5.11.0-1.26380.4"), "older engine");
    await expectAsync(server.engineFor(shim)).toBeRejectedWithError(/Several Roslyn tool versions/);
  });
  it("reads the SDK Windows shim's exact target without running it or choosing a newer version", async () => {
    const shim = path.join(scratch, "roslyn-language-server.cmd");
    const relative = `.store/roslyn-language-server/5.11.0-1.26380.4/${server.packageFor().name}/5.11.0-1.26380.4/tools/net10.0/${server.packageFor().target}/roslyn-language-server.exe`;
    const engine = path.join(
      scratch,
      path.dirname(relative),
      "Microsoft.CodeAnalysis.LanguageServer.dll",
    );
    fs.mkdirSync(path.dirname(engine), { recursive: true });
    fs.writeFileSync(engine, "selected engine");
    fs.writeFileSync(shim, `@echo off\r\n"%~dp0${relative.replaceAll("/", "\\")}" %*\r\n`);
    const newer = engine.replaceAll("5.11.0-1.26380.4", "5.12.0-1.26475.2");
    fs.mkdirSync(path.dirname(newer), { recursive: true });
    fs.writeFileSync(newer, "newer engine");
    expect(await server.engineFor(shim)).toBe(engine);
    fs.writeFileSync(shim, "echo custom script\n");
    await expectAsync(server.engineFor(shim)).toBeRejectedWithError(/Several Roslyn tool versions/);
  });
  it("selects the exact official package for six supported platforms", () => {
    for (const [platform, target] of [
      ["win32", "win"],
      ["linux", "linux"],
      ["darwin", "osx"],
    ])
      for (const arch of ["x64", "arm64"])
        expect(server.packageFor(platform, arch)).toEqual({
          name: `roslyn-language-server.${target}-${arch}`,
          target: `${target}-${arch}`,
        });
    expect(() => server.packageFor("linux", "ia32")).toThrowError(/no supported build/);
  });
  it("reads the newest NuGet version and rejects malformed metadata", async () => {
    spyOn(server, "fetchJson").and.resolveTo({
      versions: ["5.11.0-1.26380.4", "5.12.0-1.26475.2"],
    });
    expect(await server.latestServerVersion()).toBe("5.12.0-1.26475.2");
    server.fetchJson.and.resolveTo({ versions: [] });
    await expectAsync(server.latestServerVersion()).toBeRejectedWithError(
      /no valid Roslyn version/,
    );
    await expectAsync(
      server.installServer({ storagePath: scratch, version: "../escape", api: {} }),
    ).toBeRejectedWithError(/Invalid Roslyn/);
  });
  const metadata = () => ({
    id: server.packageFor().name,
    version: "5.12.0-1.26475.2",
    packageHashAlgorithm: "SHA512",
    packageHash: Buffer.alloc(64, 5).toString("base64"),
    licenseExpression: "MIT",
    repository: {
      url: "https://github.com/dotnet/roslyn",
      commit: "5b9ef758c8925995cc1edd3242727e34a71bcd7d",
    },
  });
  it("uses official catalog SHA512 provenance and preserves the full platform payload", async () => {
    spyOn(server, "fetchJson").and.callFake(async (url) =>
      url.includes("registration")
        ? { catalogEntry: "https://api.nuget.org/v3/catalog0/fixture.json" }
        : metadata(),
    );
    const api = {
      setServerInstallationStatus: jasmine.createSpy("status"),
      downloadFile: jasmine.createSpy("download").and.callFake(async (_url, directory) => {
        const payload = path.join(directory, "tools", "net10.0", server.packageFor().target);
        fs.mkdirSync(payload, { recursive: true });
        fs.writeFileSync(
          path.join(payload, "Microsoft.CodeAnalysis.LanguageServer.dll"),
          "fixture",
        );
      }),
      makeFileExecutable: jasmine.createSpy("executable").and.resolveTo(),
    };
    const installed = await server.installServer({
      storagePath: scratch,
      version: "5.12.0-1.26475.2",
      api,
    });
    expect(installed.checksum).toBe(`sha512:${Buffer.alloc(64, 5).toString("hex")}`);
    expect(installed.source).toBe("nuget");
    expect(installed.commit).toBe(metadata().repository.commit);
    expect(api.downloadFile.calls.argsFor(0)[2]).toEqual({
      type: "zip",
      digest: installed.checksum,
    });
    expect(installed.module).toBe(
      path.join(
        "tools",
        "net10.0",
        server.packageFor().target,
        "Microsoft.CodeAnalysis.LanguageServer.dll",
      ),
    );
    expect(api.makeFileExecutable).toHaveBeenCalled();
  });
  it("refuses unverified or foreign packages before downloading", async () => {
    let response = metadata();
    spyOn(server, "fetchJson").and.callFake(async (url) =>
      url.includes("registration")
        ? { catalogEntry: "https://api.nuget.org/v3/catalog0/fixture.json" }
        : response,
    );
    const api = { setServerInstallationStatus() {}, downloadFile: jasmine.createSpy("download") };
    for (const override of [
      { packageHash: "" },
      { packageHashAlgorithm: "SHA256" },
      { id: "foreign-package" },
      { licenseExpression: "Proprietary" },
      { repository: { url: "https://example.org" } },
    ]) {
      response = { ...metadata(), ...override };
      await expectAsync(
        server.installServer({ storagePath: scratch, version: "5.12.0-1.26475.2", api }),
      ).toBeRejectedWithError(/invalid Roslyn provenance/);
    }
    expect(api.downloadFile).not.toHaveBeenCalled();
  });
  it("rejects foreign metadata URLs and unsafe fixture cleanup", async () => {
    await expectAsync(server.fetchJson("https://example.org/foreign.json")).toBeRejectedWithError(
      /Unexpected NuGet/,
    );
    expect(() => removeProject(os.tmpdir())).toThrowError(/Refusing to remove/);
  });
});
