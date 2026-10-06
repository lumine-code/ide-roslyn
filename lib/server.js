const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const NUGET = "https://api.nuget.org/v3";
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const TARGETS = {
  "win32-x64": "win-x64",
  "win32-arm64": "win-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "osx-x64",
  "darwin-arm64": "osx-arm64",
};

exports.fetchJson = async (url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.nuget.org")
    throw new Error("Unexpected NuGet metadata URL.");
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`NuGet metadata returned HTTP ${response.status}.`);
  return response.json();
};
exports.run = (command, args, env, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 15000, ...options },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

exports.packageFor = (platform = process.platform, arch = process.arch) => {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`Roslyn publishes no supported build for ${platform}-${arch}.`);
  return { name: `roslyn-language-server.${target}`, target };
};

// The official tool is a relay which launches a second language-server process.
// Launch its engine directly so the hub owns the process that owns MSBuild.
// A .NET executable tool shim may sit beside a .store directory instead of its
// payload; accept that layout only when it identifies one installation.
exports.engineFor = async (command) => {
  const resolved = await fs.promises.realpath(command);
  if (
    !/^(?:roslyn-language-server|Microsoft\.CodeAnalysis\.LanguageServer)(?:\.exe|\.dll|\.cmd)?$/i.test(
      path.basename(resolved),
    )
  )
    return resolved;
  const name = "Microsoft.CodeAnalysis.LanguageServer.dll";
  const adjacent = path.join(path.dirname(resolved), name);
  const readable = async (file) => {
    try {
      return (
        (await fs.promises.stat(file)).isFile() &&
        (await fs.promises.access(file, fs.constants.R_OK)) === undefined
      );
    } catch {
      return false;
    }
  };
  if (await readable(adjacent)) return adjacent;
  // .NET 10 uses a two-line cmd shim for executable tools on Windows. Read
  // its exact SDK-written relative target as data; never execute the relay.
  if (resolved.toLowerCase().endsWith(".cmd")) {
    const script = await fs.promises.readFile(resolved, "utf8");
    const match =
      /^@echo off\r?\n"%~dp0(\.store[\\/][a-z0-9.\\/-]+[\\/]roslyn-language-server\.exe)" %\*\r?\n?$/i.exec(
        script,
      );
    if (match) {
      const target = path.resolve(path.dirname(resolved), match[1].replace(/[\\/]/g, path.sep));
      const storeRoot = path.resolve(path.dirname(resolved), ".store") + path.sep;
      if (target.startsWith(storeRoot)) {
        const engine = path.join(path.dirname(target), name);
        if (await readable(engine)) return fs.promises.realpath(engine);
      }
    }
  }
  const store = path.join(path.dirname(resolved), ".store");
  const engines = new Set();
  let packages;
  try {
    packages = await fs.promises.readdir(store, { withFileTypes: true });
  } catch {
    throw new Error(
      "The Roslyn tool's engine DLL could not be found. Select Microsoft.CodeAnalysis.LanguageServer.dll or install the complete server through Manage Servers.",
    );
  }
  for (const entry of packages) {
    if (
      !entry.isDirectory() ||
      !/^roslyn-language-server(?:\.(?:win|linux|osx)-(?:x64|arm64))?$/.test(entry.name)
    )
      continue;
    const packagePath = path.join(store, entry.name);
    for (const version of await fs.promises.readdir(packagePath, { withFileTypes: true })) {
      if (!version.isDirectory() || !VERSION.test(version.name)) continue;
      const versionPath = path.join(packagePath, version.name);
      const payloads = [versionPath];
      // SDK stores nest the RID package beneath the primary tool/version.
      for (const nested of await fs.promises.readdir(versionPath, { withFileTypes: true })) {
        if (
          !nested.isDirectory() ||
          !/^roslyn-language-server(?:\.(?:win|linux|osx)-(?:x64|arm64))?$/.test(nested.name)
        )
          continue;
        const nestedPath = path.join(versionPath, nested.name);
        for (const nestedVersion of await fs.promises.readdir(nestedPath, { withFileTypes: true }))
          if (nestedVersion.isDirectory() && VERSION.test(nestedVersion.name))
            payloads.push(path.join(nestedPath, nestedVersion.name));
      }
      for (const payload of payloads) {
        const tools = path.join(payload, "tools", "net10.0");
        for (const target of [exports.packageFor().target, "any"]) {
          const file = path.join(tools, target, name);
          if (await readable(file)) engines.add(await fs.promises.realpath(file));
        }
      }
    }
  }
  if (engines.size > 1)
    throw new Error(
      "Several Roslyn tool versions are installed. Set Server Path to the desired Microsoft.CodeAnalysis.LanguageServer.dll.",
    );
  if (!engines.size)
    throw new Error(
      "The Roslyn tool's engine DLL could not be found. Select Microsoft.CodeAnalysis.LanguageServer.dll or install the complete server through Manage Servers.",
    );
  return engines.values().next().value;
};

exports.resolveServer = async (context, { serverPath = "", dotnetPath = "" } = {}) => {
  const selectedServer = await context.resolver.select({
    configuredPath: serverPath,
    managed: () => {
      const installed = context.getManagedServer();
      return installed
        ? { path: installed.modulePath || installed.binaryPath, version: installed.version }
        : null;
    },
    kind: "file",
    names: ["roslyn-language-server"],
    // SDK .cmd files are parsed by engineFor; the shell relay is never launched.
    allowShellWrapper: true,
    signal: context.signal,
    async validate(command) {
      const server = await exports.engineFor(command);
      const isModule = server.toLowerCase().endsWith(".dll");
      await context.resolver.validateFile(server, {
        kind: isModule ? "file" : "executable",
        label: "Roslyn server",
        signal: context.signal,
      });
      return { server, isModule };
    },
  });
  if (!selectedServer) return null;
  const { server, isModule } = selectedServer.data;
  const selectedRuntime = await context.resolver.select({
    configuredPath: dotnetPath,
    names: ["dotnet"],
    kind: "executable",
    signal: context.signal,
    async validate(candidate, { signal }) {
      // dotnet on PATH is commonly a symlink into /usr/share/dotnet. The
      // apphost child uses DOTNET_ROOT, so derive it from the real host location.
      const runtime = await fs.promises.realpath(candidate);
      const directory = path.dirname(runtime);
      const env = {
        DOTNET_ROOT: directory,
        [`DOTNET_ROOT_${process.arch.toUpperCase()}`]: directory,
        DOTNET_HOST_PATH: runtime,
        PATH: directory + path.delimiter + (process.env.PATH || ""),
      };
      const runtimes = await exports.run(runtime, ["--list-runtimes"], env, {
        signal,
        cwd: context.rootPath,
      });
      if (!runtimes.split("\n").some((line) => /^Microsoft.NETCore.App\s+10\./.test(line)))
        throw new Error(
          "Roslyn requires a .NET 10 runtime. Install a .NET 10 SDK or choose its dotnet executable in .NET Path.",
        );
      const sdks = await exports.run(runtime, ["--list-sdks"], env, {
        signal,
        cwd: context.rootPath,
      });
      if (!sdks.trim())
        throw new Error(
          "Roslyn needs an installed .NET SDK to load MSBuild projects. Install the SDK required by your project.",
        );
      return { runtime, env };
    },
  });
  if (!selectedRuntime) throw new Error("Roslyn needs a .NET 10 SDK. Install it or set .NET Path.");
  const { runtime, env } = selectedRuntime.data;
  const args = ["--stdio", "--autoLoadProjects", "--telemetryLevel", "off"];
  return context.resolver.launch(
    { ...selectedRuntime, path: isModule ? runtime : server },
    {
      signal: context.signal,
      args: isModule ? [server, ...args] : args,
      env,
      version: selectedServer.version,
      cwd: context.rootPath,
      transport: "stdio",
    },
  );
};

exports.latestServerVersion = async () => {
  const { versions } = await exports.fetchJson(
    `${NUGET}/flatcontainer/roslyn-language-server/index.json`,
  );
  const latest = versions?.at(-1);
  if (!VERSION.test(latest || "")) throw new Error("NuGet returned no valid Roslyn version.");
  return latest;
};
exports.installServer = async ({ storagePath, version, api }) => {
  const { name, target } = exports.packageFor();
  const selected = version || (await exports.latestServerVersion());
  if (!VERSION.test(selected)) throw new Error("Invalid Roslyn NuGet version.");
  const normalized = selected.toLowerCase();
  api.setServerInstallationStatus("checking");
  const registration = await exports.fetchJson(
    `${NUGET}/registration5-gz-semver2/${name}/${normalized}.json`,
  );
  const metadata = await exports.fetchJson(registration.catalogEntry);
  const checksum = Buffer.from(metadata.packageHash || "", "base64");
  if (
    metadata.id?.toLowerCase() !== name ||
    metadata.version?.toLowerCase() !== normalized ||
    metadata.packageHashAlgorithm !== "SHA512" ||
    checksum.length !== 64 ||
    metadata.licenseExpression !== "MIT" ||
    metadata.repository?.url !== "https://github.com/dotnet/roslyn" ||
    !/^[a-f0-9]{40}$/i.test(metadata.repository?.commit || "")
  )
    throw new Error("NuGet returned invalid Roslyn provenance or SHA512 integrity metadata.");
  const digest = `sha512:${checksum.toString("hex")}`;
  const url = `${NUGET}/flatcontainer/${name}/${normalized}/${name}.${normalized}.nupkg`;
  api.setServerInstallationStatus("downloading");
  await api.downloadFile(url, storagePath, { type: "zip", digest });
  const directory = path.join("tools", "net10.0", target);
  const module = path.join(directory, "Microsoft.CodeAnalysis.LanguageServer.dll");
  await fs.promises.access(path.join(storagePath, module), fs.constants.R_OK);
  // Preserve the whole official tool payload,
  // including BuildHost, Targets, analyzers, licensing and native dependencies.
  await api.makeFileExecutable(
    path.join(
      storagePath,
      directory,
      process.platform === "win32"
        ? "Microsoft.CodeAnalysis.LanguageServer.exe"
        : "Microsoft.CodeAnalysis.LanguageServer",
    ),
  );
  return {
    version: selected,
    module,
    source: "nuget",
    package: name,
    repository: metadata.repository.url,
    commit: metadata.repository.commit,
    checksum: digest,
  };
};
