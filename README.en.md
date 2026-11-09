# Anti-trace

[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm version](https://img.shields.io/npm/v/anti-trace)](https://www.npmjs.com/package/anti-trace)
[![CI](https://github.com/sadgsk/Anti-trace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sadgsk/Anti-trace/actions/workflows/ci.yml)
[![Release](https://github.com/sadgsk/Anti-trace/actions/workflows/release.yml/badge.svg)](https://github.com/sadgsk/Anti-trace/actions/workflows/release.yml)
<br>
[Quick start](#quick-start) · [Documentation](#documentation) · [Issues](https://github.com/sadgsk/Anti-trace/issues) · [中文](README.md)

Anti-trace is an AI coding assistant for your terminal. It reads and edits project files, runs builds and tests, and follows up on tool results. Connect a supported model provider with your own API key and review commands, output, and diffs in the terminal.

## Install

Requires Node.js 22 or newer.

```sh
npm install -g anti-trace
```

`ati` and `anti-trace` launch the same CLI. Shell tools use Bash on macOS and Linux. On Windows, Anti-trace prefers PowerShell 7 and falls back to Windows PowerShell 5.1. Git for Windows also enables Git Bash. If Anti-trace cannot find a custom installation, set `ANTI_TRACE_GIT_BASH_PATH` to the absolute path of Git for Windows' `bin\bash.exe`.

## Quick start

1. Open a terminal in your project directory and launch Anti-trace.

   ```sh
   cd your-project
   ati
   ```

2. Enter `/config` and choose **Add configuration**. Fill in the configuration file name, provider API URL, API key, model ID, and API protocol. Set the context window for your model and optionally set an output limit. Choose **Save and use configuration** or press `Ctrl+S`.
3. Enter your first task.

   ```text
   Find this project's entry points and test commands, and explain how its main modules fit together.
   ```

Once a model is configured, you can also pipe in a single prompt. The CLI reads standard input as one message, processes it, and exits. Pipe mode blocks tools that require interactive approval.

```sh
echo "Explain the entry points in this project." | ati
```

## Key features

- **File and shell tools.** Read, create, and edit files. Use the shell to search the project, build, and run tests. Shell commands default to a 120-second timeout. Long output is shortened in the transcript, with the full output saved for later reads.
- **Terminal UI.** Stream responses with Markdown, syntax highlighting, tables, tool cards, and diffs. Type `/` to open the command menu or `@` to find and complete workspace file paths. Edit multiline drafts with undo and redo, and switch between English and Chinese with `/language`.
- **Image input.** Paste a path to an image file or use `Alt+V` (Windows) or `Ctrl+V` (macOS and Linux) to try reading an image from the clipboard. Supported formats include PNG, JPEG, GIF, and WebP. Clipboard support depends on the terminal and system tools, and the selected model must accept images.
- **Sessions and context.** Save conversations and attachments per project and continue with `/resume`. The status line shows context usage. Anti-trace can compact older messages automatically, and `/compact` lets you request compaction manually.

## Permissions and approvals

Reads are allowed by default. Writes, edits, and shell commands prompt for approval. You can approve once, allow for the current session, or deny with feedback. File changes can be previewed as diffs before approval. A session approval for file changes covers subsequent file writes and edits, while a shell approval applies to the same command in the same tool.

| Mode | Behavior |
| --- | --- |
| Default | Ask before writes, edits, and shell commands |
| `auto-edit` | Allow writes and edits automatically and ask before shell commands |
| `yolo` | Allow all tool calls automatically |

Press `Shift+Tab` to cycle through modes, or launch with `ati --auto-edit` or `ati --yolo`. Tools run with the current user's system permissions.

## Model configuration

Use `/config` to create, select, and edit configuration files. Each file can define multiple models, which you can switch between with `/model`. Anti-trace supports these APIs.

| API | JSON `api` value |
| --- | --- |
| OpenAI Chat Completions | `openai-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |

You can also copy the [example configuration](byok.example.json) to `~/.anti-trace/profiles/local/configs/main.json`. Replace the example URL, key, and model ID, then set `contextWindow` and optionally `maxOutputTokens` for your model. Each entry in `models` references a connection in `connections`, and `currentModel` is the key of the selected model entry.

- Set either `apiKey` or `apiKeyEnv` for each connection. `apiKeyEnv` refers to an environment variable available to the CLI process. You can also use a connection from the [provider presets example](byok.providers.example.json).
- Set `baseUrl` to the API root, including any required version prefix such as `/v1`. Put a full inference URL in `endpoint` when needed.
- Startup checks `CLI_AGENT_CONFIG`, the project's last selection, the user's default selection, and the sole valid configuration in the config directory, in that order. When several valid configurations are available on first launch, choose one with `/config`.
- Local data lives in `~/.anti-trace` by default. Override it with `ANTI_TRACE_HOME`. Model configurations are stored in `profiles/local/configs/`. Conversations, attachments, and long tool output are grouped by working directory under `profiles/local/projects/`.

## Commands and shortcuts

Type `/` and keep typing to filter the command menu. Use the arrow keys to select, `Enter` to confirm, `Tab` to complete, and `Esc` to close.

| Command | Purpose |
| --- | --- |
| `/help` | Show commands and shortcuts |
| `/new` / `/resume` | Start a session or resume one for the current project |
| `/config [path]` | Manage configurations or load a specific JSON file |
| `/model [model key]` | Select a model from the current configuration |
| `/reload` | Reload the current configuration |
| `/thinking [on\|off\|default]` | Enable reasoning, disable it, or use the provider default |
| `/effort` | Select `low`, `medium`, `high`, `xhigh`, or `max`. The effect depends on the model and API |
| `/thinking-display [on\|off]` | Choose whether reasoning text starts expanded |
| `/context [positive integer]` / `/compact` | Inspect or adjust the context window, or request compaction |
| `/language [zh\|en]` | Switch and remember the interface language |
| `/exit` | Exit |

| Shortcut | Action |
| --- | --- |
| `Enter` / `Shift+Enter` or `Alt+Enter` | Submit / insert a newline |
| `Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z` | Undo / redo draft changes |
| `Ctrl+C` | Interrupt generation or clear the draft. Exit when idle with an empty draft |
| `Ctrl+O` | Expand or collapse tool output and reasoning text |
| Scroll wheel or `PgUp` / `PgDn` / `Ctrl+End` | Browse history / return to the latest output |

Shortcut support depends on the terminal.

## Development

```sh
git clone https://github.com/sadgsk/Anti-trace.git
cd Anti-trace
npm ci
npm start
```

`npm test` runs the offline tests. `npm run check` runs type checks, tests, and a build. Branch pushes and pull requests trigger GitHub Actions CI on Windows, macOS, and Linux with Node.js 22 and 24.

Pushing a `vX.Y.Z` version tag triggers the npm release workflow. It checks that the tag matches the package version and that the commit is in `main`, then publishes after CI and package installation checks pass.

## Documentation

- [Testing and CI](docs/testing.md)
- [npm release process](docs/releases.md)
- [Architecture and implementation notes](docs/architecture.md)

## License

[MIT](LICENSE).
