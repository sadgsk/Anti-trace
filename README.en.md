# Anti-trace

[中文](README.md) | **English**

Anti-trace is a personal CLI agent that uses your own model credentials (BYOK). You can chat with a model in the terminal, let it read and edit project files, execute commands, and continue work through saved sessions.

**The goal: let the agent dynamically modify its own capabilities from a one-sentence request, then apply the changes through a hot restart.** The project is in early development. This capability has not been implemented.

![Anti-trace proposed architecture: the existing agent foundation, planned feature changes, validation, and hot restart](docs/assets/target-architecture.svg)

## Project goal

Describe a feature you want to add or change in natural language. The agent would understand the request, plan and implement the changes, then apply them through a hot restart. The intended scope includes tools, the CLI interface, and other agent CLI capabilities. The modification mechanism, validation process, and hot-restart workflow still need to be designed and implemented.

Current work builds the foundation for that goal: model integration, tool execution, sessions, context management, and terminal interaction. Implemented capabilities and future plans are listed separately below.

The project started by studying and referencing [Pi](https://github.com/earendil-works/pi). Some foundational code was adapted from Pi. Anti-trace uses its own `Harness` and feature design, and does not currently depend on Pi runtime packages. See the [architecture document](docs/architecture.md) for the current design.

## Implemented capabilities

| Capability | Current implementation |
|---|---|
| Chat and tools | Multi-turn conversations, streaming output, cancellation, and the `read` / `write` / `edit` / `bash` tools |
| Sessions | Linear JSONL sessions scoped to the working directory, with `/new` and `/resume` |
| Context management | Configurable context windows, usage display, automatic summary compaction, and manual `/compact` |
| Terminal input | Multiline editing, paste merging, long-text and image references, undo, and redo |
| Protocol adapters | Requests and streaming for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages |
| Model configuration | BYOK JSON, model selection and configuration reload for the current run, plus a reasoning toggle and five effort preferences configured through JSON |

The capabilities above describe the current `main` branch. Provider connection presets, interactive reasoning controls, per-request credential resolution, unified compaction settings, and session settings restoration are under development and have not been merged into the main branch. See [BYOK build](docs/byok-build.md) for the development plan.

## Roadmap and work awaiting integration

- [ ] Plan and implement dynamic changes to tools, the CLI interface, and other capabilities from a one-sentence request.
- [ ] Design a validation workflow and apply capability changes through a hot restart.
- [ ] Integrate the provider connection presets, interactive reasoning controls, and unified settings workflow currently under development.
- [ ] Establish a reproducible test framework with end-to-end coverage for all three protocols.
- [ ] Address recorded issues with tool pairing after interruption, Windows command execution, and context-overflow error display.
- [ ] Expand verification with real models, terminal platforms, and clipboards; add model bindings as needed.
- [ ] Improve TUI interaction in v1.3.

These capabilities are not all available on the main branch. Some are being developed locally, with no promised delivery dates. See [progress.md](docs/progress.md) for development and verification records.

## Quick start

You need Node.js 22 or newer, plus API access and credentials for your chosen model provider.

1. Clone the repository, enter the project directory, and run `npm install`.
2. Copy [byok.example.json](byok.example.json) to `byok.json` in the project root.
3. Set the connection's API key and URL, and the model ID, context window, and output limit. Select the model key with `currentModel`. The default `main` entry contains a placeholder URL and model ID that must be replaced.
4. Run `npm start`, then enter `/help` to see the available commands.

Tools can read, write, and edit files and execute local commands. These actions affect the current working directory. Use a recoverable copy of a project for initial evaluation.

## Models and configuration

BYOK JSON is the only startup model configuration source. It contains model connections, URLs, context windows, and output limits. `currentModel` selects a key in `models`; models reference entries in `connections` through `connection`. By default, the CLI reads `byok.json` from the startup working directory. Set the `CLI_AGENT_CONFIG` process environment variable to use another JSON file; relative paths are resolved against the working directory.

`byok.json` is ignored by Git. Do not commit real credentials; the examples contain placeholders only. A connection can alternatively use `apiKeyEnv` to reference a process environment variable. `.env` files are not loaded.

Include the required version prefix in `baseUrl`, such as `/v1`; the protocols append `/chat/completions`, `/responses`, or `/messages` without adding another `/v1`. Use `endpoint` for a full inference URL; `baseUrl` is still required. `thinking.effort` stores one of five levels. Omitting `enabled` uses the server default. Explicitly enabling or disabling reasoning uses `adapter.thinking`; missing rules or an unsupported explicit disable fail before HTTP. Models can override connection-level adapter defaults. Supported configuration includes effort, toggles, five-level budget templates, output fields, usage, and reasoning replay from the same source. See [Chat adapter configuration](docs/byok-build.md#62-第-0304-批的-chat-adapter-配置). Do not assume a gateway accepts a provider's native parameters solely because model names match.

All three protocols use `streamModel()`. Chat handles the `reasoning_content` string field, optionally configured as `reasoning`, and preserves reasoning replay data after complete success. Reasoning replay is omitted by default. When explicitly enabled, only valid data from the same model, connection, and actual endpoint is replayed. Truncated, failed, or canceled streams do not produce replayable reasoning data; a stream without an end reason fails explicitly. Reasoning events reach the Agent; CLI reasoning display still awaits integration.

## Interaction and commands

Enter submits. Shift/Alt+Enter, or a backslash followed by Enter, inserts a newline. Ctrl+Z undoes; Ctrl+Y or a recognized Ctrl+Shift+Z redoes. Ctrl+C interrupts generation or clears the draft; when idle with an empty draft, it exits. Ctrl+D exits. Up and Down move within the current input and do not recall input history. You can paste image paths. Windows uses Alt+V to read an image from the clipboard; macOS/Linux use Ctrl+V. Modified-key support depends on terminal encoding.

Use `/help` for commands, `/new` for a new session, `/resume` to list sessions and select one by number, `/context [positive integer]` to view or adjust the window, `/compact` to attempt manual compaction, and `/exit` to quit. Non-TTY input is submitted as one complete message at EOF; for example, `printf 'Explain this code\nSecond line' | npm start`.

Currently, reasoning enablement and effort preferences are configured through `thinking` in the BYOK JSON. Interactive reasoning commands, reasoning display, and session settings restoration still await integration.

The Harness starts independently of model configuration. Missing or invalid configuration produces a diagnostic while `/new`, `/resume`, context usage display, and help remain available. Operations that need a model, such as chat, compaction, or changing its context window, ask for valid configuration when needed. An unset window is shown as unconfigured.

After editing the JSON, enter `/reload` to reload it without restarting. **This command only reloads model configuration; it does not modify tools or the CLI interface, and is not the planned capability hot restart.** `/config` shows status; `/config <path>` loads another file; `/model <model-key>` selects a model for the current run. Without arguments, model selection shows usage and available keys; success produces a short confirmation, and failure explains why. Loading validates structure, references, URLs, and parameter constraints. Invalid candidate configuration preserves the valid configuration, messages, and session. Selections and paths are not written back to the configuration JSON. Switching files uses the new file's default model.

Startup and reload do not probe remote availability or resolve environment keys in advance. Chat and summary operations resolve `apiKeyEnv` when credentials are needed. Missing keys, request encoding failures, and HTTP errors end the current operation while leaving the CLI usable. Environment changes in another terminal do not appear in a running process; file-based credential sources can be changed and reloaded instead. In pipe mode, the complete input is read first. Configuration diagnostics go to stderr; session commands can still succeed, while failed model operations return exit code 1.

Responses uses `store: false` and full input history, preserving encrypted reasoning items for replay with their source. It handles text, images, tool deltas, usage, and terminal states. Anthropic uses `x-api-key`, `anthropic-version`, and a required output limit; it supports budgeted/adaptive reasoning, full signatures and redacted thinking, tool results, and combined cache usage. Both default to `reasoningReplay: "same-source"` and save replayable data only after complete success. See [Responses / Anthropic configuration](docs/byok-build.md#63-responsesanthropic-配置与初始绑定) for configuration and initial model bindings. The examples include both protocols; select the corresponding model key and supply credentials.

## Current limitations and verification scope

- The current interface is a REPL. A full TUI remains on the roadmap.
- On Windows, the `bash` tool actually uses `cmd.exe`. Command failures and hangs are recorded in [future-issues.md](docs/future-issues.md).
- Tool pairing after interruption and premature display of recoverable context-overflow errors still need work; see the [review records](docs/review-records.md).
- Local HTTP SSE and macOS POSIX PTY verification records exist. Verification with real models, regional accounts, clipboards, and other terminal platforms remains incomplete.
- Existing ad hoc tests are local only. The repository does not yet provide a reproducible automated test suite. `npm run typecheck` and `npm run build` check types and build the project; they do not replace functional tests.

## Development documentation

The detailed development documents are currently in Chinese.

- [Development progress](docs/progress.md): current status, pending work, and history. Start here when continuing development.
- [Architecture](docs/architecture.md): module responsibilities, current design, future goals, and verification boundaries.
- [Main execution flow](docs/main-flow.md): diagrams and sequence charts from input submission through model requests, tool execution, and completion.
- [BYOK build](docs/byok-build.md): configuration and adapter design, delivery, and review records.

## License

This project is available under the [MIT License](LICENSE). Portions derived from Pi retain their original copyright and license notice.
