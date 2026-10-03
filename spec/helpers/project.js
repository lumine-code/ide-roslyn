const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const os = require("node:os");

const source = `using System;

public interface IAdder { int Add(int value); }
public class Calculator : IAdder {
 public int Add(int value) { return value + 1; }
 /// <summary>Returns twice its input.</summary>
 public static int Double(int value) { return value * 2; }
 public int Use() {
  string emoji = "😀"; var result = Double(3);
  return Add(result);
 }
 public void Broken() { missingName(); }
 public string Display() => "hello".ToUpper();
 public int External() => Support.Helper.Triple(3);
}
`;
const position = (text, fragment, inside = 0) => {
  const index = text.indexOf(fragment);
  if (index < 0) throw new Error(`Fixture has no '${fragment}'.`);
  const before = text.slice(0, index + inside).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
};
const createProject = (rootPath) => {
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, "Demo.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Remove="Support/**/*.cs"/><ProjectReference Include="Support/Support.csproj"/></ItemGroup></Project>\n',
  );
  fs.mkdirSync(path.join(rootPath, "Support"), { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, "Support", "Support.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
  );
  const supportPath = path.join(rootPath, "Support", "Helper.cs");
  fs.writeFileSync(
    supportPath,
    "namespace Support; public static class Helper { public static int Triple(int value) => value * 3; }\n",
  );
  fs.writeFileSync(
    path.join(rootPath, "Demo.slnx"),
    '<Solution><Project Path="Demo.csproj"/><Project Path="Support/Support.csproj"/></Solution>\n',
  );
  const filePath = path.join(rootPath, "Calculator.cs");
  fs.writeFileSync(filePath, source);
  return {
    rootPath,
    filePath,
    supportPath,
    projectPath: path.join(rootPath, "Demo.csproj"),
    uri: pathToFileURL(filePath).href,
    text: source,
  };
};
const prepareProject = (fixture, dotnet) =>
  new Promise((resolve, reject) =>
    execFile(
      dotnet,
      ["restore", fixture.projectPath],
      {
        timeout: 90000,
        windowsHide: true,
        env: {
          ...process.env,
          DOTNET_ROOT: path.dirname(dotnet),
          DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
        },
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`Fixture restore failed: ${stdout}\n${stderr}`, { cause: error }))
          : resolve(),
    ),
  );
const removeProject = (rootPath) => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const absolute = path.resolve(rootPath);
  if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith("ide-csharp-"))
    throw new Error(`Refusing to remove unexpected fixture path '${absolute}'.`);
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};
module.exports = { source, position, createProject, prepareProject, removeProject };
