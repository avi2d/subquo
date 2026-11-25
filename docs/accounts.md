---
kind: reference
---
# Account list

The account list maps each paid subscription to the login Claude Code, Codex, or OpenCode already uses on this machine.

## File and fields

Keep a separate `~/.config/subquo/accounts.toml` on each machine, with file mode `0600`.
List each paid account in its own `[[accounts]]` entry, even if two accounts use the same provider.
Do not put passwords, tokens, API keys, or account emails in this file.
Do not commit the file or copy logins between machines.

| Field | Required value |
| --- | --- |
| `id` | A unique, stable local label of 1 to 64 lowercase letters, digits, hyphens, or underscores. Start with a letter or digit. |
| `provider` | `claude`, `codex`, or `opencode-go`. |
| `login.store` | `file` or `macos-keychain`. Use `macos-keychain` only for Claude Code on macOS. |
| `login.path` | For `file`, the absolute path to the provider's login file. |
| `login.config_dir` | For `macos-keychain`, the absolute path Claude Code uses as its configuration directory for this account. |
| `login.service` | For `macos-keychain`, the service name of the account's Keychain item, not its value. Use the exact item name, either `Claude Code-credentials` or its `Claude Code-credentials-<hash>` form. |

Each `login` table lists only the fields for its store.
On Linux or Windows Subsystem for Linux, use `file` for Claude Code.
For a custom Claude Code directory on macOS, match the exact directory spelling in `CLAUDE_CONFIG_DIR`.
For a Claude Code file, use its existing `.credentials.json` file.
For a Codex account, use the `auth.json` file in the Codex home folder, `~/.codex` by default, or the one Pi saves in its agent folder, `~/.pi/agent` by default.
For OpenCode Go, use the existing `opencode/auth.json` under its data directory.

## Example

Replace the example IDs and locators with your own.

```toml
[[accounts]]
id = "example-claude-one"
provider = "claude"
login = { store = "macos-keychain", config_dir = "/path/to/example/claude-one", service = "Claude Code-credentials" }

[[accounts]]
id = "example-claude-two"
provider = "claude"
login = { store = "file", path = "/path/to/example/claude-two/.credentials.json" }

[[accounts]]
id = "example-codex"
provider = "codex"
login = { store = "file", path = "/path/to/example/codex/auth.json" }

[[accounts]]
id = "example-opencode"
provider = "opencode-go"
login = { store = "file", path = "/path/to/example/opencode/auth.json" }
```
