# Context Doctor Preview

Context Doctor is an agent-first diagnostic toolkit for maintaining the accuracy, consistency and integrity of coding agent instructions. It combines deterministic repository analysis with the reasoning capabilities of existing coding agents to identify, investigate and resolve context drift.

No API keys. No additional inference costs from the tool itself. No infrastructure. No model dependency.

Just a new capability for the agent.

**Status** · v0.1.0-alpha.3

## Try it in a repository

Run `node --version` in the shell you will use to check your repository. The preview uses the Node.js installation on that shell's PATH. Use Node.js 22.18+, 24.11+ or 26+ on the supported release lines. Git enables working-tree discovery and changed-path scans.

From the repository you want to review, run:

```sh
npx 'github:loueed/context-doctor-preview#v0.1.0-alpha.3' scan
```

If your project uses an older Node.js version, put a supported installation first on PATH for this command. This works even when a project runtime shim selects an older version.

```sh
PATH="/path/to/node26/bin:$PATH" npx 'github:loueed/context-doctor-preview#v0.1.0-alpha.3' scan
```

Use `scan --inventory` for structured findings, document inventory and analysis coverage. To scan another checkout, pass its path after `scan`. A scan is read-only and never executes commands found in repository files. A clean scan means the checks found no reported issues in the selected scope. It does not establish that the guidance is complete or useful.

## Use with a coding agent

Add the [Context Doctor skill](skills/context-doctor/SKILL.md) directory, including its references, to your coding agent. Install the preview CLI so the skill's examples are available as written:

```sh
npm install --global 'github:loueed/context-doctor-preview#v0.1.0-alpha.3'
```

Then ask:

> Run Context Doctor and propose fixes.

Without a global install, tell the agent to replace the `context-doctor` prefix in each example with `npx 'github:loueed/context-doctor-preview#v0.1.0-alpha.3'`.

## Feedback

Open an issue with the command, what you expected and what happened. A small synthetic reproduction is ideal. Review any diagnostic output for sensitive paths, commands or values before sharing it.

## Rules

| ID                                 | Severity | Evidence                                                                                                               |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `broken-markdown-link`             | Error    | A local link destination or Markdown heading anchor is missing.                                                        |
| `reference-not-found`              | Warning  | An inline file, directory, or configuration reference has no matching location or the referenced directory is a file.  |
| `script-not-defined`               | Error    | An explicit command names a script absent from the selected manifest.                                                  |
| `script-scope-unknown`             | Warning  | The owning manifest could not be established.                                                                          |
| `script-shorthand-unresolved`      | Warning  | A supported Yarn or pnpm task name is absent from the selected manifest and no matching executable evidence was found. |
| `workspace-target-unresolved`      | Warning  | A supported pnpm or Yarn selector matches zero or multiple manifests in the declared workspace.                        |
| `dependency-not-declared`          | Warning  | A package explicitly identified as a dependency is absent from the nearest manifest's dependency sections.             |
| `node-version-mismatch`            | Warning  | A documented Node.js version is incompatible with the nearest pin or supported engine range.                           |
| `wiki-source-not-found`            | Error    | A declared raw source file is missing in a wiki that documents this convention.                                        |
| `script-mutates-files`             | Error    | A script explicitly described as read-only or non-mutating runs Stylelint, ESLint, or Oxlint with a literal fix flag.  |
| `node-minimum-incompatible`        | Warning  | A documented minimum is incompatible with the engine range of a locked direct npm dependency.                          |
| `package-manager-mismatch`         | Warning  | An explicit package-manager requirement differs from the nearest manifest pin or same-directory lockfile evidence.     |
| `package-manager-version-mismatch` | Warning  | An exact documented package-manager version differs from the nearest manifest pin.                                     |

The scan starts with AGENTS, Claude, and skill instructions, then follows local Markdown links. In Git working trees it includes tracked and non-ignored untracked guidance. Outside Git it walks the selected directory and skips common generated directories. Relative links resolve from the containing document. A leading slash in a Markdown link resolves from the repository root. Inline paths beginning with a dot resolve from the containing document. Bare inline paths can also resolve from the repository root. A bare Markdown filename can resolve through an earlier referenced **README.md** or **index.md** when one index links directly to that filename in its own directory. A missing indexed file includes the target, index and source line that established the scope. A scoped scan reports findings only within the requested path and can inspect other paths in the same working tree to resolve references.

Script checks cover inline code and shell fences, including explicit npm, pnpm, Yarn, Bun, and Vite+ run commands, npm test, and Yarn and pnpm shorthand for `build`, `test`, `lint`, `typecheck` and their hyphen or colon variants. The parser accepts simple literal environment assignments and a same-line `cd directory && command`. An npm prefix or literal working directory is resolved against the repository root and the document directory. A single manifest must resolve for a scoped check. Unscoped commands use the nearest manifest. Dynamic directories and working directories established on previous shell lines are outside this check. Mark illustrative shell fences with the `example` info string.

Named workspace commands can use pnpm `--filter` or `-F`, or Yarn's `workspace` subcommand. Context Doctor starts from the instruction document, finds the nearest workspace declaration and matches manifest names within its declared package directories. It recognises literal directory segments, `*`, `**` and simple exclusions in the declaration. Candidate manifests come from the Git index and non-ignored working tree or the filesystem walk. The finding includes the workspace declaration and the selected manifest or matching candidates. An explicitly introduced example with an unresolved target appears as an inventory skip. npm workspace flags, compound selectors and workspace commands combined with a working-directory prefix remain outside this check. Workspace membership disappearing after a package deletion may require a full scan to surface. [pnpm filtering](https://pnpm.io/filtering) · [Yarn workspace commands](https://classic.yarnpkg.com/en/docs/cli/workspace)

An absent shorthand script produces a warning because package managers can also resolve executables. Inventory records cases skipped for executable evidence or unresolved Yarn colon syntax, which can select scripts in other workspaces. A clean checkout can lack installed binaries, and dependencies may expose executables under different names. [Yarn Classic run](https://classic.yarnpkg.com/en/docs/cli/run) · [Yarn run](https://yarnpkg.com/cli/run) · [pnpm run](https://pnpm.io/cli/run)

Dependency checks recognise an inline package name following **Dependency:** or in prose such as **requires the PACKAGE package**. They check declarations and work with a fresh checkout. Version checks recognise individual version mentions and compare them with numeric pins in Node version files or Volta, then fall back to the nearest manifest's engine range. Treat these findings as observations that may need interpretation.

Package-manager checks recognise explicit Markdown requirements such as **Package Manager** followed by a named tool, `Use pnpm for package management`, or a sentence stating which package manager the project must use. An exact version on the **Package Manager** line is checked against the nearest manifest’s `packageManager` pin. Without a pin, a single manager’s lockfiles in the same directory provide weaker evidence. Git scans use tracked lockfiles for this fallback. Inventory records ambiguous lockfiles, unsupported `devEngines.packageManager` settings and unavailable version pins. Install examples and version ranges are outside these checks. [Corepack package-manager configuration](https://github.com/nodejs/corepack#when-authoring-packages)

The additional checks use narrow evidence. The lint check reads the leading linter command in the selected npm script and a direct claim in the same document. The runtime check uses an npm lockfile and explicit minimum syntax such as Node.js 18+. It needs a manifest whose directory matches the named package, or a single manifest for a project-level statement. The wiki check applies to YAML source entries rooted under raw/ when a wiki configuration documents that convention.

## Inventory and coverage

```sh
context-doctor scan --inventory
context-doctor scan --inventory --include-observed
context-doctor scan --inventory --entry CONTRIBUTING.md --entry docs/workflow.md
context-doctor scan --inventory --changed --base main
```

Use `--include-observed` to analyse recognised Markdown guidance in the scan directory, including Claude rules, Copilot instructions, **AGENTS.override.md** and **GEMINI.md**. Cursor's `.mdc` and extensionless rules remain visible as unsupported formats in inventory. The checks inspect files as Markdown. Agent-specific metadata, apply-to patterns and loader behaviour require independent verification.

Use repeatable `--entry` for specific guides, such as a contributing guide in a repository with no default instruction files. Entry paths are relative to the repository root and must resolve to Markdown files within the scan directory. Entries augment the default set and can follow local links within the scan scope. In Git, convention discovery still respects ignore rules. An explicit entry can select an ignored guide. New entry options require a directory scope. Use `--path` alone to restrict a scan to a single Markdown file.

Inventory mode adds `inventory` to schema version 1 and selects JSON. The normal scan retains its existing fields, pagination, diagnostic IDs and exit codes. The intentional validation change rejects malformed manifest maps. A recognised script with an invalid selected manifest yields the existing scope warning instead of passing on an array index, and inventory identifies the parse or shape failure.

- `inventory.documents` contains repository-relative paths, file format, convention, containing directory, selection reason, link depth and status. `analysed` means the scanner parsed the document. `observed-only` means a recognized filename convention was found without selecting the file for analysis. `unavailable` means a selected source could not be read as a repository file.
- Default entries are **AGENTS.md**, **CLAUDE.md** and **SKILL.md**. The `via` value is `included-convention` for opt-in Markdown guidance, `explicit-file` for a named entry or a file supplied with `--path`, and `local-link` for a document discovered through a link. The inventory describes structural discovery. Loader behaviour and effective context require independent evidence.
- `links` counts recognised local link occurrences and samples the first 20 destinations per document. Depth starts at zero for selected entries and follows the first discovered link route. Links to evidence outside the scan scope can be checked without traversing the target document’s instructions.
- `measurements` reports UTF-8 bytes of the decoded document, physical lines, headings and repeated headings, paragraphs and recognised references. Paragraphs are matched after whitespace normalization within one document. Headings use trimmed display text and references use their extracted kind, value and prefix. Each repeat category gives totals and up to ten groups with five sample line locations. These patterns direct review and carry no quality judgment.
- `checks` counts recognised inputs per reference kind. An examined input completed its supported check. A skipped input hit a known limit or missing prerequisite. Findings can accompany skipped inputs, as with unknown script scope. Counts cover the analysed documents before finding pagination or severity and changed-path filtering. A missing counter means no input of that kind was extracted. `limitations` records reason counts with up to five examples. It includes known parse failures, unavailable prerequisites and some command syntax outside the parser.
- Git discovery uses tracked and non-ignored untracked files. Directly linked files can be visited within scope. Files excluded from traversal are not enumerated. Inventory records recoverable permission failures for selected files or evidence. Repository-wide Git or traversal failures still exit 2.
- Inventory omits raw lint script bodies and link query strings from evidence. It includes a script body digest for comparison and retains the manifest pointer. Paths and other evidence may still be sensitive. Ordinary scan output keeps the existing raw evidence contract.

## Before-and-after comparison

Capture both reports locally in the same checkout with the same scan scope. Store them outside the repository. Exit 1 on either scan still yields a report.

```sh
reports=$(mktemp -d)
context-doctor scan --inventory --all > "$reports/before.json"
# Apply an authorised change.
context-doctor scan --inventory --all > "$reports/after.json"
context-doctor compare "$reports/before.json" "$reports/after.json"
```

`--all` returns all findings from one scan and makes `page.limit` null. It cannot be combined with `--limit` or `--offset`. Ordinary pages still rerun analysis, so use a saved report when repeatedly inspecting a large result. Comparison accepts complete `--inventory --all` reports with both severities. Use the same scope, `--include-observed` setting and explicit entry files in both scans. Comparison rejects changed-path, partial, filtered or incompatible scope inputs. It emits JSON and exits 0 when the comparison ran, or 2 on failure. Use the result fields to judge the outcome.

Complete inventories carry a snapshot version and an opaque checkout ID derived from the canonical root. Findings carry a check key derived from the extracted input. Comparison uses source path, rule and check key while pairing identical evidence independently of line number. Unique matches with changed evidence are `modified`. `introduced` means newly reported in the after scan. `cleared` requires a unique equivalent check that passed after the edit. A deleted source, rewritten input, unavailable check or unresolved occurrence ambiguity goes to `unverified`. An observation can therefore disappear while verification remains open. Per-document changes report discovery status, measurements and coverage counts. Identical repeated occurrences are paired by count and their individual identity may be ambiguous.

## JSON interface

`scan --json` writes one report to stdout. `--format json` is equivalent. The default terminal format is available with `--format text`. The JSON contract uses `schemaVersion: 1` with these fields:

- `scope` records the scan path and the resolved merge base for changed scans. With either entry option, `scope.selection` records `includeObserved` and a sorted, deduplicated list of repository-relative `entries`.
- `summary` counts analysed documents and all findings at the selected severity.
- `page` exposes `offset`, `limit`, and `nextOffset`. Follow `nextOffset` to read additional findings.
- `findings` contains a stable rule ID, severity, confidence, a one-based source line and column, rule-specific evidence, and guidance for investigation. Shorthand paths can include up to five verified tracked suffix matches in `candidates`. A bare filename in a nested document can suggest tracked matches below that document’s directory. Confidence reflects how explicitly the source identifies the version, package, command, or path. Paths are relative to the scan's repository root.

Related findings can carry the same `reviewGroup.id` across pages. Resolve the shared question once and use each finding’s source location when proposing changes. Repeated references to the same unresolved path within a document share a review group. Table labels can suggest manifest candidates for review. Immutable snapshots carry their revision when available.

The default limit is 100 findings. Exit code **0** means the scan completed with no findings at the selected severity, **1** means findings exist, and **2** means the command could not complete. When the exit code is 2, read stderr. Use `--severity error` for error findings only. Rule explanations also accept aliases from CD001 to CD013.

`--changed` reports existing findings whose source or inspected evidence overlaps with committed, staged, unstaged, or non-ignored untracked changes. By default it uses the first available ref from the remote default branch, local main, local master, and HEAD. Pass `--base` to select the comparison ref explicitly. This mode scopes a current working-tree scan. A finding in scope can predate the branch.
