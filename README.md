# agenticmart-cli

agenticmart is a command line tool that searches AgenticMart listings, shows a listing's scan status and advisories, and adds an MCP server entry to your client's config file after you confirm.

It has no runtime dependencies and needs Node 20 or newer.

## Install

```sh
npx github:EshaRana17/agenticmart-cli search files
```

## Usage

```sh
agenticmart search <query> [--type mcp|agent|skill] [--limit n] [--json]
agenticmart info <type>/<slug> [--json]
agenticmart install <type>/<slug> --client claude-code|cursor|vscode|windsurf [--config file] [--dry-run] [--yes]
```

Set `AGENTICMART_API` to use a different API base URL.

`install` shows the install command, the scan status and any advisories, then asks y/N. It writes the entry only for plain `npx` or `uvx` commands. Runs without a terminal refuse unless you pass `--yes`.

The example below is real output from a test run against a local stand-in for the API, with made-up listing data:

```text
$ agenticmart search files
mcp/example-files  Example Files  stars:42  license:MIT  scan:booted
  Read and write local files.

$ agenticmart install mcp/example-files --client cursor --dry-run --config mcp.json
Example Files (mcp/example-files)
Install command: npx -y example-files-mcp
Scan: booted, checked 2026-11-01T00:00:00Z, commit abc123def456, booted true, 1 tools listed
  A scan reports what was observed. Tools are not executed during scans.
Advisories: 1
  GHSA-xxxx-yyyy: Path traversal in read_file (fixed: 1.2.3) https://example.test/a

Would add to "mcpServers" in mcp.json:
{
  "example-files": {
    "type": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "example-files-mcp"
    ]
  }
}
Other server entries kept: 0. The file is created.
Your client will run this command when it starts the server. agenticmart does not run it.
Dry run: nothing was written.
```

## Where entries are written

| Client | File | Key | Source |
| --- | --- | --- | --- |
| `claude-code` | `.mcp.json` in the current folder (project scope) | `mcpServers` | [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers` | [Cursor MCP docs](https://cursor.com/docs/context/mcp) |
| `vscode` | `.vscode/mcp.json` in the current folder | `servers` | [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | [Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp) |

Notes from those docs, checked in November 2026:

- Claude Code's docs recommend `claude mcp add` for user scope and do not document that layout, so this tool only writes the project file. Claude Code asks for approval before using servers from `.mcp.json`.
- VS Code's user profile `mcp.json` has no documented literal path, so this tool writes the workspace file. VS Code's guided flow labels the workspace and profile files as deprecated while its configuration reference still documents them.
- The Windsurf docs URL now redirects to [Devin docs](https://docs.devin.ai/desktop/cascade/mcp), which list `~/.config/devin/mcp_config.json`. If your install reads that file, pass `--config ~/.config/devin/mcp_config.json`.

An existing file is copied to `<file>.agenticmart-backup-<time>` first. Other entries and keys are kept. If an entry with the same name but different settings exists, nothing is changed.

## Limits

- It never runs the install command. Your client runs it later, when it starts the server, and that is when the package is downloaded and executed.
- A scan status describes what AgenticMart observed at one commit. Tools are not executed during scans, and a passing status says nothing about later releases.
- Advisories show only what AgenticMart has on record. An empty list does not mean a package has no problems.
- Commands other than plain `npx` or `uvx`, or commands containing shell syntax, are not written. Install those by hand.
- Config files with comments (JSONC) are refused and left unchanged, since rewriting them would lose the comments.
- On Windows, some clients need `cmd /c npx ...` to start servers. This tool writes the command as listed.
- The interactive y/N prompt is tested through its input handling, not in a real terminal session.
- The AgenticMart API contract used here is new; the tests run against a local stand-in.

## Tests

```sh
node --test
```

25 tests, all passing on Node 24.14.0 on Windows 10.

## License

MIT

Developed by [buildwithesha.web.app](https://buildwithesha.web.app/) for [AgenticMart](https://agenticmart.org)
