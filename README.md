# ide-csharp

Provide C# language features with Roslyn.

Registers Microsoft's standalone MIT-licensed [Roslyn language server](https://www.nuget.org/packages/roslyn-language-server) with `ide-client`. Install `language-csharp` for syntax highlighting and the editor service frontends for the features you want to display.

## Features

- **Code intelligence**: supplies compiler and analyzer diagnostics, completion, hover and signature help.
- **Navigation**: finds source and metadata definitions, references, document and workspace symbols, call hierarchies and type hierarchies.
- **Refactoring**: renames symbols and applies Roslyn code fixes and refactorings through workspace edits.
- **Formatting**: formats documents and selections with Roslyn, preserving project formatting preferences.
- **Inline information**: supplies parameter and type hints and semantic tokens.
- **Server discovery**: uses Server Path, an editor-managed installation or roslyn-language-server on PATH, in that order.
- **Managed installation**: downloads the official platform NuGet package and verifies its published SHA512 hash before extracting the complete server and MSBuild payload.
- **Project support**: discovers solutions and MSBuild projects and keeps their references, analyzers, generated sources and SDK selection intact.

## Installation

To install `ide-csharp` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-csharp`.

Install `ide-client`, `language-csharp` and a [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0). Roslyn needs the .NET 10 runtime to start and an SDK to load MSBuild projects. Keep any other SDKs required by project `global.json` files installed too. A portable SDK can be selected through .NET Path without changing your system PATH.

Use `ide-client:manage-servers` to install Roslyn, or install the official tool with `dotnet tool install --global roslyn-language-server --prerelease`. Managed installation uses Microsoft's official `roslyn-language-server.<platform>` packages from NuGet, including their MIT license and the whole build host tree. It follows the current prerelease distribution because Microsoft has not published a stable version of this standalone tool. It does not install a .NET SDK or copy binaries from an editor extension.

Managed builds are available for Windows, Linux and macOS on x64 and ARM64. The adapter launches Microsoft.CodeAnalysis.LanguageServer.dll directly from the official package, so the editor owns the process that loads MSBuild. It resolves that engine beside an explicitly selected tool, from the SDK's Windows command shim, or from a unique .NET tool installation. If a shim does not identify one installation, select the desired engine DLL explicitly. .NET Path chooses the runtime that launches it. Installing or removing a managed server leaves your SDKs, project dependencies and separately installed servers intact.

## Usage

Open the folder containing your `.sln`, `.slnx` or `.csproj` as a project, then open a C# file. Roslyn discovers projects with its supported `--autoLoadProjects` option and loads their MSBuild dependency graph. Restore the project with its usual `dotnet restore` command when its dependencies are unavailable; the adapter never rewrites a project, solution or `global.json` file.

Inlay hints follow Roslyn's defaults until Parameter Hints or Type Hints is enabled in settings. Feature switches control which results the editor uses and support scoped overrides. References code lenses and Roslyn's client-only Fix All commands require editor integrations that are not available here; code lenses are disabled and unsupported commands are filtered by `ide-client`. Standard code actions that resolve to workspace edits remain available.

## Services

- `ide-client`: consumed to register and configure the C# language server.
- `background-tips.provider`: provided to background-tips to describe C# projects and SDK setup.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
