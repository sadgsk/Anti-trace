# ResidualX

[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![CI](https://github.com/sadgsk/ResidualX/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sadgsk/ResidualX/actions/workflows/ci.yml)
[![Release](https://github.com/sadgsk/ResidualX/actions/workflows/release.yml/badge.svg)](https://github.com/sadgsk/ResidualX/actions/workflows/release.yml)
<br>
[Quick start](#quick-start) · [Documentation](#documentation) · [Issues](https://github.com/sadgsk/ResidualX/issues) · [中文](README.md)

ResidualX is an AI coding assistant for your terminal. It reads and edits project files, runs builds and tests, and follows up on tool results. Connect a supported model provider with your own API key and review commands, output, and diffs in the terminal.

## Install

Requires Node.js 22 or newer.

```sh
npm install -g residualx
```

After installation, launch `rex` or `residualx`. Existing installations keep their configuration and session directories. Shell tools use Bash on macOS and Linux. On Windows, ResidualX prefers PowerShell 7 and falls back to Windows PowerShell 5.1. Git for Windows also enables Git Bash. If ResidualX cannot find a custom installation, set `RESIDUALX_GIT_BASH_PATH` to the absolute path of Git for Windows' `bin\bash.exe`.

## Quick start

1. Open a terminal in your project directory and launch ResidualX.

   ```sh
   cd your-project
   rex
   ```

2. Enter `/config` and choose **Add configuration**. Fill in the configuration file name, provider API URL, API key, model ID, and API protocol. Set the context window for your model and optionally set an output limit. Choose **Save and use configuration** or press `Ctrl+S`.
3. Enter your first task.

   ```text
   Find this project's entry points and test commands, and explain how its main modules fit together.
   ```

Once a model is configured, you can also pipe in a single prompt. The CLI reads standard input as one message, processes it, and exits. Pipe mode blocks tools that require interactive approval.

```sh
echo "Explain the entry points in this project." | residualx
```

## Key features

- **File and shell tools.** Read, create, and edit files. Use the shell to search the project, build, and run tests. Shell commands default to a 120-second timeout. Long output is shortened in the transcript, with the full output saved for later reads.
- **Terminal UI.** Stream responses with Markdown, syntax highlighting, tables, tool cards, and diffs. Type `/` to open the command menu or `@` to find and complete workspace file paths. Edit multiline drafts with undo and redo, and switch between English and Chinese with `/language`.
- **Image input.** Paste a path to an image file or use `Alt+V` (Windows) or `Ctrl+V` (macOS and Linux) to try reading an image from the clipboard. Supported formats include PNG, JPEG, GIF, and WebP. Clipboard support depends on the terminal and system tools, and the selected model must accept images.
- **Sessions and context.** Save conversations and attachments per project and continue with `/resume`. Use `/context` to see the working directory, model, reasoning effort and context usage. ResidualX can compact older messages automatically, and `/compact` lets you request compaction manually.

## Skills

Open `/skill` for a second-level picker, use `/skill review current branch` to invoke directly, or `/skill --reload` for diagnostics. Skills with argument hints ask for arguments first. Individual skills do not become top-level commands.

Store project skills at `cwd/.residualx/skills/<name>/SKILL.md`; discovery uses only the current working directory, without walking its parents. Store user skills at `~/.residualx/skills/<name>/SKILL.md` (relative to `RESIDUALX_HOME`, shared across projects and profiles). Project definitions override user definitions.

The system prompt supplies both resolved directories and the file format, even before any skills exist. Ask in chat to create a skill: project storage is the default; personal or cross-project skills use user storage. Existing file/shell tools create the files, which are discovered before the next model request.

```markdown
---
name: review
description: Review changes. Use when asked to inspect a diff or find regressions.
argument-hint: "[scope]"
---

Review scope: $ARGUMENTS
Read changes and callers, then report confirmed issues with severity and locations.
```

Names must match their directories and use lowercase letters, numbers and hyphens. Description and instructions are required. Bundle scripts/references/assets alongside the file. Use existing file or shell tools to create skills. Discovery refreshes when opening the picker and before each model request.

The model first receives names/descriptions; the unified `skill` tool loads selected instructions. Supports `$ARGUMENTS`, positional and named `arguments`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`, `disable-model-invocation` and `user-invocable`. Instructions persist through session restore and budgeted compaction.

`allowed-tools` accepts plain `read`, `edit`, `write`, `bash`, `powershell` names or lists (including title-case aliases). Model calls with grants require approval; manual invocation applies declared grants for that turn. Grants do not survive session restore. Other operations use the existing policy.

Only inline skills are supported. Command-pattern grants, inline shell injection, path conditions, skill-specific models/effort, fork, hooks and plugin sources report loading diagnostics.

## Permissions and approvals

Reads are allowed by default. Writes, edits, and shell commands prompt for approval. You can approve once, allow for the current session, or deny with feedback. File changes can be previewed as diffs before approval. A session approval for file changes covers subsequent file writes and edits, while a shell approval applies to the same command in the same tool.

| Mode | Behavior |
| --- | --- |
| Default | Ask before writes, edits, and shell commands |
| `auto-edit` | Allow writes and edits automatically and ask before shell commands |
| `yolo` | Allow all tool calls automatically |

Press `Shift+Tab` to cycle through modes, or launch with `residualx --auto-edit` or `residualx --yolo`. Tools run with the current user's system permissions.

## Model configuration

Use `/config` to create, select, and edit configuration files. Each file can define multiple models, which you can switch between with `/model`. ResidualX supports these APIs.

| API | JSON `api` value |
| --- | --- |
| OpenAI Chat Completions | `openai-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |

You can also copy the [example configuration](byok.example.json) to `~/.residualx/profiles/local/configs/main.json`. Replace the example URL, key, and model ID, then set `contextWindow` and optionally `maxOutputTokens` for your model. Each entry in `models` references a connection in `connections`, and `currentModel` is the key of the selected model entry.

- Set either `apiKey` or `apiKeyEnv` for each connection. `apiKeyEnv` refers to an environment variable available to the CLI process. You can also use a connection from the [provider presets example](byok.providers.example.json).
- Set `baseUrl` to the API root, including any required version prefix such as `/v1`. Put a full inference URL in `endpoint` when needed.
- Startup checks `RESIDUALX_CONFIG`, the project's last selection, the user's default selection, and the sole valid configuration in the config directory, in that order. When several valid configurations are available on first launch, choose one with `/config`.
- Local data lives in `~/.residualx` by default. Override it with `RESIDUALX_HOME`. Model configurations are stored in `profiles/local/configs/`. Conversations, attachments, and long tool output are grouped by working directory under `profiles/local/projects/`.

## Commands and shortcuts

Type `/` and keep typing to filter the command menu. Use the arrow keys to select, `Enter` to confirm, `Tab` to complete, and `Esc` to close.

| Command | Purpose |
| --- | --- |
| `/help` | Show commands and shortcuts |
| `/new` / `/resume` | Start a session or resume one for the current project |
| `/config [path]` | Manage configurations or load a specific JSON file |
| `/model [model key]` | Select a model from the current configuration |
| `/mcp` | Manage MCP servers, connections and catalogs |
| `/mcp-resource [server URI]` | Read a resource, preview it and insert it into the draft |
| `/mcp-prompt [server name JSON-arguments]` | Expand a server prompt, preview it and insert it into the draft |
| `/reload` | Reload the current configuration |
| `/thinking [on\|off\|default]` | Enable reasoning, disable it, or use the provider default |
| `/effort` | Select `low`, `medium`, `high`, `xhigh`, or `max`. The effect depends on the model and API |
| `/thinking-display [on\|off]` | Choose whether reasoning text starts expanded |
| `/context [positive integer]` / `/compact` | View session information, adjust the context window, or request compaction |
| `/language [zh\|en]` | Switch and remember the interface language |
| `/skill [name arguments\|--reload]` | Open the skill picker, invoke a skill, or reload |
| `/exit` | Exit |

| Shortcut | Action |
| --- | --- |
| `Enter` / `Shift+Enter` or `Alt+Enter` | Submit / insert a newline |
| `Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z` | Undo / redo draft changes |
| `Ctrl+C` | Interrupt generation or clear the draft. Exit when idle with an empty draft |
| `Ctrl+O` | Expand or collapse tool output and reasoning text |
| Scroll wheel or `PgUp` / `PgDn` / `Ctrl+End` | Browse history / return to the latest output |

Shortcut support depends on the terminal.

## MCP server management

Start the CLI and enter `/mcp` to add, edit, trust, connect, disable or remove servers and inspect Tools, Resources, URI Templates and Prompts. Model configuration is not required. Choose a scope and transport when adding a server:

- Current project: `<cwd>/.residualx/mcp.json`. Explicit trust is required before starting or connecting.
- All projects: `~/.residualx/profiles/local/mcp.json`. A project entry replaces the entire user entry with the same name.

User configuration and private state follow `RESIDUALX_HOME` and are isolated by profile. Project configuration can be committed to Git; reference credentials through environment variables. OAuth credentials, trust and local enable/disable overrides live in the private user directory `~/.residualx/profiles/local/mcp/`. Example:

```json
{
  "version": 1,
  "mcpServers": {
    "local": { "type": "stdio", "command": "node", "args": ["/absolute/path/server.mjs"] },
    "remote": {
      "type": "http",
      "url": "https://your-server.example/mcp",
      "auth": { "type": "bearer", "tokenEnv": "MCP_ACCESS_TOKEN" }
    }
  }
}
```

Replace the example command and URL, then use `/mcp trust local`, `/mcp reconnect local`, and `/mcp tools local`. For OAuth, configure `"auth": { "type": "oauth" }` and run `/mcp login <server>` to authorize in your browser. Pre-registered `clientId`, `clientSecretEnv`, `scopes` and `callbackPort` are also supported. Run `/mcp reload` after editing files; invalid candidates retain the last valid configuration.

Both stdio and Streamable HTTP automatically probe protocol support, preferring the modern protocol and using the SDK's legacy handshake fallback. No `legacy / modern` setting is needed. The old dedicated HTTP+SSE transport is outside this release. Pipes can run `printf '/mcp list' | npm start`; trust, configuration forms and interactive login require a terminal.

On Windows, stdio process management requires system Windows PowerShell and Job Objects. Environments that disable PowerShell or Add-Type report a connection failure.

On submission, the harness connects to enabled, trusted servers or reuses their existing connections. It offers their compatible tools alongside built-in tools and pins the same connections and definitions through tool continuations and context recovery. Configure `enabledTools` and `disabledTools` per server. Default and auto-edit modes require approval for model-initiated MCP operations. Long results and binary attachments are stored under the project's `tool-results/mcp/` directory.

The model can use `mcp_list_resources` and `mcp_read_resource` to discover and read a specific URI. To choose material yourself, use `/mcp-resource` or `/mcp-prompt`. Examples include `/mcp-resource docs docs://guide` and `/mcp-prompt docs review {"topic":"release"}`. In a terminal, preview and confirm the material to insert it into an editable draft. A pipe prints the expanded material. Both commands work before a model is configured. See the [MCP design](docs/architecture.md#56-mcp).

## Development

```sh
git clone https://github.com/sadgsk/ResidualX.git
cd ResidualX
npm ci
npm start
```

`npm test` runs the offline tests. `npm run check` runs type checks, tests, and a build. Branch pushes and pull requests trigger GitHub Actions CI on Windows, macOS, and Linux with Node.js 22 and 24.

Pushing a `vX.Y.Z` version tag triggers the npm release workflow. It checks that the tag matches the package version and that the commit is in `main`, then publishes after CI and package installation checks pass.

## Documentation

- [Testing and CI](docs/architecture.md#8-测试与-ci)
- [npm release process](docs/progress.md#npm-发布流程)
- [Architecture and implementation notes](docs/architecture.md)

## License

[MIT](LICENSE).
