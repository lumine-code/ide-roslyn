const path = require("node:path");
const fs = require("node:fs");

describe("Roslyn metadata request lifetime", () => {
  let server, controller;
  const version = "5.0.0";
  const response = (data) => ({ ok: true, json: async () => data });
  function deferred() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("ide-roslyn");
    server = require("../lib/server");
    controller = new AbortController();
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-roslyn");
    await lumine.packages.deactivatePackage("ide");
  });
  it("does not fetch for an already cancelled API", async () => {
    const fetch = spyOn(global, "fetch").and.resolveTo(response({ versions: [version] }));
    controller.abort(new Error("cancelled lookup"));
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError("cancelled lookup");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a fetch completing after cancellation", async () => {
    const held = deferred();
    spyOn(global, "fetch").and.returnValue(held.promise);
    const pending = server.latestServerVersion({ signal: controller.signal });
    controller.abort(new Error("cancelled fetch"));
    held.resolve(response({ versions: [version] }));
    await expectAsync(pending).toBeRejectedWithError("cancelled fetch");
  });
  it("rejects a JSON body completing after cancellation", async () => {
    const held = deferred();
    let reading = false;
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      json() {
        reading = true;
        return held.promise;
      },
    });
    const pending = server.latestServerVersion({ signal: controller.signal });
    await conditionPromise(() => reading);
    controller.abort(new Error("cancelled body"));
    held.resolve({ versions: [version] });
    await expectAsync(pending).toBeRejectedWithError("cancelled body");
  });
  it("keeps the 30-second deadline through body parsing", async () => {
    const timeout = new AbortController(),
      held = deferred();
    let reading = false;
    const deadline = spyOn(AbortSignal, "timeout").and.returnValue(timeout.signal);
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      json() {
        reading = true;
        return held.promise;
      },
    });
    const pending = server.latestServerVersion({ signal: controller.signal });
    await conditionPromise(() => reading);
    timeout.abort(new Error("metadata deadline"));
    held.resolve({ versions: [version] });
    await expectAsync(pending).toBeRejectedWithError("metadata deadline");
    expect(deadline).toHaveBeenCalledOnceWith(30000);
  });
  it("preserves current network, HTTP and provenance failures", async () => {
    const fetch = spyOn(global, "fetch").and.resolveTo({ ok: false, status: 503 });
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError(/HTTP 503/);
    fetch.and.rejectWith(new Error("network offline"));
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError("network offline");
    await expectAsync(
      server.fetchJson("https://example.com/metadata", { signal: controller.signal }),
    ).toBeRejectedWithError(/Unexpected NuGet/);
  });
  it("does not download after catalog body cancellation", async () => {
    const held = deferred();
    let reading = false,
      calls = 0;
    spyOn(global, "fetch").and.callFake(async () =>
      ++calls === 1
        ? response({ catalogEntry: "https://api.nuget.org/catalog.json" })
        : {
            ok: true,
            json() {
              reading = true;
              return held.promise;
            },
          },
    );
    spyOn(fs.promises, "access").and.resolveTo();
    const api = {
      signal: controller.signal,
      setServerInstallationStatus() {},
      downloadFile: jasmine.createSpy("download").and.resolveTo(),
      makeFileExecutable: jasmine.createSpy("executable").and.resolveTo(),
    };
    const pending = server.installServer({
      version,
      api,
      storagePath: path.join(lumine.getConfigDirPath(), "unused-roslyn-stage"),
    });
    await conditionPromise(() => reading);
    controller.abort(new Error("cancelled catalog"));
    held.resolve({
      id: server.packageFor().name,
      version,
      packageHash: Buffer.alloc(64, 1).toString("base64"),
      packageHashAlgorithm: "SHA512",
      licenseExpression: "MIT",
      repository: { url: "https://github.com/dotnet/roslyn", commit: "a".repeat(40) },
    });
    await expectAsync(pending).toBeRejectedWithError("cancelled catalog");
    expect(api.downloadFile).not.toHaveBeenCalled();
    expect(api.makeFileExecutable).not.toHaveBeenCalled();
  });
  for (const mode of ["caller cancellation", "adapter withdrawal"]) {
    it(`cancels real ManagedServers transport on ${mode}`, async () => {
      await lumine.packages.deactivatePackage("ide-roslyn");
      const ide = (await lumine.packages.activatePackage("ide")).mainModule;
      await lumine.packages.activatePackage("ide-roslyn");
      const managed = ide.ensureManagedServers(),
        held = deferred();
      let signal;
      spyOn(global, "fetch").and.callFake((_url, options) => {
        signal = options.signal;
        return held.promise;
      });
      const pending = managed.latestVersion(managed.adapterFor("ide-roslyn"), {
        force: true,
        signal: controller.signal,
      });
      await conditionPromise(() => signal);
      if (mode === "caller cancellation") controller.abort();
      else await lumine.packages.deactivatePackage("ide-roslyn");
      await expectAsync(pending).toBeRejected();
      expect(signal.aborted).toBe(true);
      held.resolve(response({ versions: [version] }));
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(managed.latest.has("ide-roslyn")).toBe(false);
    });
  }
});
