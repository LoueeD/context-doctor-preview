# Context architecture

Read this for comprehensive assessment, nested instructions, branch scope or an agent-specific task.

## Trace a representative task

1. Name the action, affected paths, intended agent and invocation directory. Review read-only discovery evidence first.
2. Inventory conventions, explicit files and linked documents. Follow the path a reviewer would take, from entry instructions to relevant workflow and owning configuration. For each relevant file, record presence, discovery route, intended applicability and any evidence of loading.
3. Use the agent’s documented behavior for its version and configuration or an observable loader trace to establish actual loading. Markdown filenames, matching directory ancestry and inferred precedence support hypotheses. A linked runbook may only be retrieved by an agent that follows the link. A skill may require discovery and activation. User-level overrides and injected context can change the result.
4. Evaluate navigation separately for agents that start at the repository root, work in a nested directory or act on a target path from elsewhere. A clean scan of one Markdown file may verify an anchor outside the scan without exploring that destination’s instructions.

## Interpret the inventory

- A default entry is a Context Doctor discovery result for a familiar basename. A file found through a local link is reachable from a selected document. An observed-only file matches an additional convention and was not analysed.
- Directory is the containing directory. Depth is the first local-link route from a selected entry. Neither describes instruction precedence. Links are structural edges, while the inclusion decision depends on scope, the loader and the task.
- Read the document status, per-kind checks and limitation counts before interpreting totals. Some syntax never becomes a parsed reference. Absence of a check counter means that the scanner emitted no candidate of that kind in the document.
- Under Git, discovery uses the tracked index and non-ignored untracked files. A local Markdown link can still reach an ignored file. In a filesystem walk, inspect scope and conventional directory exclusions before comparing coverage with a Git scan.
- Size and repeated paragraphs or headings indicate where to inspect. Preserve necessary expertise in a large specialist guide when it is retrieved only for the relevant task. A small root entry may deserve attention if it hides the location of a critical procedure.

## Resolve authority with evidence

A directory-local build instruction may legitimately override or narrow a root command. Two commands are in tension only if they govern the same action, paths and conditions and would lead to materially different behavior. Identify the controlling project policy and use actual build configuration or CI as corroboration. When current instructions and an immutable snapshot disagree, check the snapshot revision and intended historical purpose before proposing any change.
