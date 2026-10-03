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
exports.run = (command, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 15000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

exports.packageFor = (platform = process.platform, arch = process.arch) => {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`Roslyn publishes no supported build for ${platform}-${arch}.`);
  return { name: `roslyn-language-server.${target}`, target };
};

exports.findOnPath = (name, env = process.env) => {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const suffix of process.platform === "win32" ? ["", ".exe"] : [""]) {
      const candidate = path.join(directory, name + suffix);
      try {
        if (fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        /* Keep searching. */
      }
    }
  }
  return null;
};

exports.resolveServer = async (configured, managed, dotnet) => {
  const server =
    configured ||
    managed?.modulePath ||
    managed?.binaryPath ||
    exports.findOnPath("roslyn-language-server");
  if (!server) return null;
  if (!(await fs.promises.stat(server)).isFile())
    throw new Error("The configured Roslyn path is not a server file.");
  const isModule = server.toLowerCase().endsWith(".dll");
  await fs.promises.access(server, isModule ? fs.constants.R_OK : fs.constants.X_OK);
  const selectedRuntime = dotnet || exports.findOnPath("dotnet");
  if (!selectedRuntime) throw new Error("Roslyn needs a .NET 10 SDK. Install it or set .NET Path.");
  // dotnet on PATH is commonly a symlink into /usr/share/dotnet. The
  // apphost child uses DOTNET_ROOT, so derive it from the real host location.
  const runtime = await fs.promises.realpath(selectedRuntime);
  await fs.promises.access(runtime, fs.constants.X_OK);
  const directory = path.dirname(runtime);
  const env = {
    DOTNET_ROOT: directory,
    [`DOTNET_ROOT_${process.arch.toUpperCase()}`]: directory,
    DOTNET_HOST_PATH: runtime,
    PATH: directory + path.delimiter + (process.env.PATH || ""),
  };
  const runtimes = await exports.run(runtime, ["--list-runtimes"], env);
  if (!runtimes.split("\n").some((line) => /^Microsoft.NETCore.App\s+10\./.test(line)))
    throw new Error(
      "Roslyn requires a .NET 10 runtime. Install a .NET 10 SDK or choose its dotnet executable in .NET Path.",
    );
  const sdks = await exports.run(runtime, ["--list-sdks"], env);
  if (!sdks.trim())
    throw new Error(
      "Roslyn needs an installed .NET SDK to load MSBuild projects. Install the SDK required by your project.",
    );
  const args = ["--stdio", "--autoLoadProjects", "--telemetryLevel", "off"];
  return {
    command: isModule ? runtime : server,
    args: isModule ? [server, ...args] : args,
    env,
    version: configured ? undefined : managed?.version,
  };
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
  const module = path.join(directory, "roslyn-language-server.dll");
  await fs.promises.access(path.join(storagePath, module), fs.constants.R_OK);
  // The thin client launches this apphost. Preserve its whole NuGet payload,
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
