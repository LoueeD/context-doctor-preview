#!/usr/bin/env node
import { parseArgs, promisify, stripVTControlCharacters, styleText } from "node:util";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { gfm } from "micromark-extension-gfm";
import { intersects, minVersion, satisfies, valid, validRange } from "semver";
// src/discovery/repository.ts
const exec = promisify(execFile);
const instructionNames = [
	"AGENTS.md",
	"CLAUDE.md",
	"SKILL.md"
];
const additionalPatterns = [
	"**/AGENTS.override.md",
	"**/GEMINI.md",
	"**/.github/copilot-instructions.md",
	"**/.github/instructions/**/*.instructions.md",
	"**/.cursor/rules/**/*.mdc",
	"**/.claude/rules/**/*.md",
	"**/.cursorrules"
];
function contextConvention(path) {
	const name = posix.basename(path);
	if (instructionNames.includes(name)) return name;
	if (name === "AGENTS.override.md" || name === "GEMINI.md") return name;
	if (/(?:^|\/)\.github\/(?:copilot-instructions\.md$|instructions\/.*\.instructions\.md$)/.test(path)) return "copilot";
	if (/(?:^|\/)\.cursor\/rules\/.*\.mdc$/.test(path) || name === ".cursorrules") return "cursor";
	if (/(?:^|\/)\.claude\/rules\/.*\.md$/.test(path)) return "claude-rules";
	return null;
}
function isMarkdown(path) {
	return /\.md(?:own|arkdown)?$/i.test(path);
}
const skipped = /* @__PURE__ */ new Set([
	".git",
	"node_modules",
	".venv",
	".cache",
	"dist",
	"coverage"
]);
function within(root, path) {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}
function displayPath(root, path) {
	return relative(root, path).split(sep).join("/") || ".";
}
async function git(cwd, args) {
	const { stdout } = await exec("git", [
		"-C",
		cwd,
		...args
	], {
		env: {
			...process.env,
			GIT_OPTIONAL_LOCKS: "0"
		},
		maxBuffer: 33554432
	});
	return stdout;
}
async function openRepository(cwd, requestedPath) {
	const requested = await realpath(resolve(cwd, requestedPath ?? "."));
	const directory = (await stat(requested)).isDirectory() ? requested : dirname(requested);
	const gitRoot = await git(directory, ["rev-parse", "--show-toplevel"]).then((output) => output.replace(/\r?\n$/, "")).catch((error) => {
		if (error.code === "ENOENT" || error.stderr?.includes("not a git repository")) return null;
		throw error;
	});
	const root = gitRoot ? await realpath(gitRoot) : directory;
	return {
		root,
		scope: requestedPath ? requested : root,
		isGit: Boolean(gitRoot)
	};
}
async function findOnDisk(path, matchesFile) {
	if (!(await stat(path)).isDirectory()) return [path];
	const matches = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (skipped.has(entry.name)) continue;
		const child = resolve(path, entry.name);
		if (entry.isDirectory()) matches.push(...await findOnDisk(child, matchesFile));
		else if (entry.isFile() && matchesFile(child, entry.name)) matches.push(child);
	}
	return matches;
}
async function workingPaths(root, patterns) {
	const output = await git(root, [
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		...patterns.map((pattern) => ":(glob)" + pattern)
	]);
	return [...new Set(output.split("\0").filter(Boolean))].sort();
}
async function packageManifestPaths(repository) {
	const { root } = repository;
	return (repository.isGit ? await workingPaths(root, ["**/package.json"]) : (await findOnDisk(root, (_, name) => name === "package.json")).map((path) => displayPath(root, path))).filter((path) => !path.split("/").some((segment) => skipped.has(segment))).sort();
}
async function explicitEntry(repository, requested) {
	const path = resolve(repository.root, requested);
	if (!isMarkdown(path) || !within(repository.scope, path)) throw new Error("--entry must name a Markdown file within the scan scope (" + requested + ")");
	const target = await realpath(path).catch((error) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error("--entry file was not found (" + requested + ")");
		throw error;
	});
	if (!isMarkdown(target) || !within(repository.scope, target) || !(await stat(target)).isFile()) throw new Error("--entry must resolve to a Markdown file within the scan scope (" + requested + ")");
	return path;
}
async function discover(repository, { inventory, includeObserved, entries = [] }) {
	const { root, scope, isGit } = repository;
	const selected = /* @__PURE__ */ new Map();
	if ((await stat(scope)).isFile()) {
		if (!isMarkdown(scope)) throw new Error("--path must be a directory or Markdown file");
		if (includeObserved || entries.length) throw new Error("--include-observed and --entry require a directory scan scope");
		selected.set(scope, "explicit-file");
		return {
			selected,
			other: []
		};
	}
	const includeOther = Boolean(inventory || includeObserved);
	const explicit = /* @__PURE__ */ new Set();
	for (const entry of entries) explicit.add(await explicitEntry(repository, entry));
	const paths = !isGit ? (await findOnDisk(scope, (path, name) => instructionNames.includes(name) || includeOther && contextConvention(displayPath(root, path)) !== null)).sort() : (await workingPaths(root, [...instructionNames.map((name) => "**/" + name), ...includeOther ? additionalPatterns : []])).map((path) => resolve(root, path)).filter((path) => within(scope, path)).sort();
	const other = [];
	for (const path of paths) if (instructionNames.includes(posix.basename(displayPath(root, path)))) selected.set(path, "default-entry");
	else if (includeObserved && isMarkdown(path)) selected.set(path, "included-convention");
	else if (!explicit.has(path)) other.push(path);
	for (const path of [...explicit].sort()) selected.set(path, "explicit-file");
	return {
		selected,
		other,
		selection: includeObserved || explicit.size ? {
			includeObserved: Boolean(includeObserved),
			entries: [...explicit].map((path) => displayPath(root, path)).sort()
		} : void 0
	};
}
async function isIgnored(repository, path) {
	if (!repository.isGit) return false;
	try {
		await git(repository.root, [
			"check-ignore",
			"--quiet",
			"--",
			path
		]);
		return true;
	} catch (error) {
		if (error.code === 1) return false;
		throw error;
	}
}
async function trackedPaths(repository) {
	if (!repository.isGit) return [];
	const output = await git(repository.root, [
		"ls-files",
		"--cached",
		"-z"
	]);
	const paths = /* @__PURE__ */ new Set();
	for (const file of output.split("\0").filter(Boolean)) {
		paths.add(file);
		for (let directory = posix.dirname(file); directory !== "." && !paths.has(directory); directory = posix.dirname(directory)) paths.add(directory);
	}
	return [...paths].sort();
}
async function changes(repository, requestedBase) {
	const { root } = repository;
	if (!repository.isGit) throw new Error("--changed requires a Git working tree");
	const revision = (ref) => git(root, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		ref + "^{commit}"
	]).then((output) => output.trim()).catch(() => null);
	const head = await revision("HEAD");
	const refs = requestedBase ? [requestedBase] : [
		"refs/remotes/origin/HEAD",
		"refs/heads/main",
		"refs/heads/master",
		"HEAD"
	];
	let base = null;
	for (const ref of refs) {
		const commit = await revision(ref);
		if (!commit) continue;
		if (!head) throw new Error("A branch comparison requires a HEAD commit");
		base = {
			ref,
			commit: (await git(root, [
				"merge-base",
				commit,
				head
			])).trim()
		};
		break;
	}
	if (requestedBase && !base) throw new Error("Unknown base revision: " + requestedBase);
	const diff = [
		"diff",
		"--no-ext-diff",
		"--name-only",
		"--no-renames",
		"-z"
	];
	const outputs = await Promise.all([
		git(root, [...diff, "--"]),
		git(root, [
			...diff,
			"--cached",
			"--"
		]),
		git(root, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z"
		]),
		base ? git(root, [
			...diff,
			base.commit,
			"HEAD",
			"--"
		]) : ""
	]);
	return {
		base,
		paths: new Set(outputs.flatMap((output) => output.split("\0").filter(Boolean)))
	};
}
// src/resolvers/working-tree.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function localTarget(document, root, reference, link) {
	if (/^(?:[a-z][a-z+.-]*:|\/\/)/i.test(reference)) return null;
	const [address, ...fragmentParts] = link ? reference.split("#") : [reference];
	let fragment = fragmentParts.join("#");
	let path = link ? address.split("?")[0] : address;
	if (link) try {
		path = decodeURIComponent(path);
		fragment = decodeURIComponent(fragment);
	} catch {
		return null;
	}
	if (path.includes("\0") || path.includes("\\") || !link && isAbsolute(path)) return null;
	const rootRelative = link && path.startsWith("/");
	const target = path ? resolve(rootRelative ? root : dirname(document), rootRelative ? path.slice(1) : path) : document;
	if (!within(root, target)) return null;
	return {
		path: target,
		fragment
	};
}
var WorkingTree = class {
	locations = /* @__PURE__ */ new Map();
	manifests = /* @__PURE__ */ new Map();
	root;
	constructor(root) {
		this.root = root;
	}
	locate(path) {
		let result = this.locations.get(path);
		if (!result) {
			result = this.inspect(path);
			this.locations.set(path, result);
		}
		return result;
	}
	async inspect(path) {
		if (!within(this.root, path)) return null;
		try {
			const resolved = await realpath(path);
			if (!within(this.root, resolved)) return {
				path,
				kind: "other"
			};
			const info = await stat(resolved);
			return {
				path: resolved,
				kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other"
			};
		} catch (error) {
			if ([
				"ENOENT",
				"ENOTDIR",
				"ELOOP",
				"ENAMETOOLONG"
			].includes(error.code ?? "")) return null;
			throw error;
		}
	}
	async read(path) {
		const entry = await this.locate(path);
		return entry?.kind === "file" ? readFile(entry.path, "utf8") : null;
	}
	async manifest(document) {
		for (const directory of this.ancestors(document)) {
			const manifest = await this.manifestAt(directory);
			if (manifest) return manifest;
		}
		return null;
	}
	manifestAt(directory) {
		let result = this.manifests.get(directory);
		if (!result) {
			result = this.readManifest(directory);
			this.manifests.set(directory, result);
		}
		return result;
	}
	async readManifest(directory) {
		const path = resolve(directory, "package.json");
		const contents = await this.read(path);
		if (contents === null) return null;
		try {
			const value = JSON.parse(contents.replace(/^\uFEFF/, ""));
			if (!isRecord(value)) return {
				path,
				data: null,
				issue: "invalid-shape"
			};
			if ([
				"scripts",
				"dependencies",
				"devDependencies",
				"optionalDependencies",
				"peerDependencies"
			].some((key) => Object.hasOwn(value, key) && (!isRecord(value[key]) || Object.values(value[key]).some((entry) => typeof entry !== "string")))) return {
				path,
				data: null,
				issue: "invalid-shape"
			};
			return {
				path,
				data: value
			};
		} catch {
			return {
				path,
				data: null,
				issue: "invalid-json"
			};
		}
	}
	*ancestors(document, stop) {
		for (let directory = dirname(document); within(this.root, directory); directory = dirname(directory)) {
			yield directory;
			if (directory === this.root || directory === stop) break;
		}
	}
};
const configName = /^(?:\.(?:nvmrc|node-version|npmrc|gitignore|env(?:\.[\w-]+)?)|(?:tsconfig(?:\.[\w-]+)?|package(?:-lock)?|deno|biome|turbo)\.json|(?:pnpm-workspace|pnpm-lock)\.yaml|yarn\.lock|[\w-]+\.config\.[cm]?[jt]s)$/;
function isConfiguration(reference) {
	return configName.test(basename(reference.replace(/\/$/, "")));
}
// src/analysis/compare.ts
const snapshotError = "Expected a complete, unfiltered scan --inventory --all JSON report";
async function snapshot(path) {
	let report;
	const input = await readFile(path, "utf8");
	try {
		report = JSON.parse(input);
	} catch {
		throw new Error("Invalid JSON report at " + path);
	}
	if (!isRecord(report) || report.schemaVersion !== 1 || !isRecord(report.scope) || typeof report.scope.path !== "string" || report.scope.changed !== false || report.scope.selection !== void 0 && (!isRecord(report.scope.selection) || typeof report.scope.selection.includeObserved !== "boolean" || !Array.isArray(report.scope.selection.entries) || !report.scope.selection.entries.every((entry) => typeof entry === "string")) || !isRecord(report.page) || report.page.offset !== 0 || report.page.limit !== null || report.page.nextOffset !== null || !isRecord(report.summary) || !Array.isArray(report.findings) || report.summary.total !== report.findings.length || !isRecord(report.inventory) || report.inventory.snapshotVersion !== 1 || report.inventory.minimumSeverity !== "warning" || typeof report.inventory.checkoutId !== "string" || !Array.isArray(report.inventory.documents)) throw new Error(snapshotError);
	for (const finding of report.findings) if (!isRecord(finding) || typeof finding.rule !== "string" || typeof finding.checkKey !== "string" || !isRecord(finding.source) || typeof finding.source.file !== "string" || !isRecord(finding.evidence)) throw new Error(snapshotError);
	for (const document of report.inventory.documents) if (!isRecord(document) || typeof document.path !== "string" || ![
		"analysed",
		"observed-only",
		"unavailable"
	].includes(String(document.status)) || !isRecord(document.checks) || !isRecord(document.limitations) || !Object.values(document.limitations).every((value) => isRecord(value) && typeof value.count === "number") || document.status === "analysed" && (!Array.isArray(document.successfulChecks) || !Array.isArray(document.duplicateChecks) || !isRecord(document.measurements) || typeof document.measurements.bytes !== "number" || typeof document.measurements.lines !== "number")) throw new Error(snapshotError);
	return report;
}
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function evidenceKey(finding) {
	return JSON.stringify(canonical([
		finding.severity,
		finding.confidence,
		finding.evidence,
		finding.candidates
	]));
}
function groups(findings) {
	const groups = /* @__PURE__ */ new Map();
	for (const finding of findings) {
		const key = JSON.stringify([
			finding.source.file,
			finding.rule,
			finding.checkKey
		]);
		const entries = groups.get(key) ?? [];
		entries.push(finding);
		groups.set(key, entries);
	}
	return groups;
}
async function compareReports(beforePath, afterPath) {
	const [before, after] = await Promise.all([snapshot(beforePath), snapshot(afterPath)]);
	if (before.scope.path !== after.scope.path || before.inventory.discovery !== after.inventory.discovery || before.inventory.checkoutId !== after.inventory.checkoutId) throw new Error("Snapshots must use the same checkout, discovery method and scan scope");
	if (JSON.stringify(canonical(before.scope.selection)) !== JSON.stringify(canonical(after.scope.selection))) throw new Error("Snapshots must use the same --entry files and --include-observed setting");
	const beforeDocs = new Map(before.inventory.documents.map((document) => [document.path, document]));
	const afterDocs = new Map(after.inventory.documents.map((document) => [document.path, document]));
	const oldGroups = groups(before.findings);
	const newGroups = groups(after.findings);
	const introduced = [];
	const unchanged = [];
	const modified = [];
	const cleared = [];
	const unverified = [];
	for (const key of /* @__PURE__ */ new Set([...oldGroups.keys(), ...newGroups.keys()])) {
		const original = oldGroups.get(key) ?? [];
		const current = newGroups.get(key) ?? [];
		const exact = /* @__PURE__ */ new Map();
		for (const finding of [...current].reverse()) {
			const signature = evidenceKey(finding);
			const matches = exact.get(signature) ?? [];
			matches.push(finding);
			exact.set(signature, matches);
		}
		const unmatched = [];
		for (const finding of original) {
			const match = exact.get(evidenceKey(finding))?.pop();
			if (match) unchanged.push({
				before: finding.source,
				after: match
			});
			else unmatched.push(finding);
		}
		const remaining = [...exact.values()].flat();
		if (original.length === 1 && current.length === 1 && unmatched.length && remaining.length) {
			modified.push({
				before: unmatched[0],
				after: remaining[0]
			});
			continue;
		}
		introduced.push(...remaining);
		for (const finding of unmatched) {
			const document = afterDocs.get(finding.source.file);
			const key = finding.checkKey ?? "";
			if (document?.status !== "analysed") unverified.push({
				finding,
				reason: "source-no-longer-analysed"
			});
			else if (original.length > 1 || current.length > 1 || beforeDocs.get(finding.source.file)?.duplicateChecks?.includes(key) || document.duplicateChecks?.includes(key)) unverified.push({
				finding,
				reason: "ambiguous-occurrence"
			});
			else if (document.successfulChecks?.includes(key)) cleared.push(finding);
			else unverified.push({
				finding,
				reason: "equivalent-check-did-not-pass"
			});
		}
	}
	const documents = [.../* @__PURE__ */ new Set([...beforeDocs.keys(), ...afterDocs.keys()])].sort().flatMap((path) => {
		const describe = (document) => document ? {
			status: document.status,
			via: document.via,
			depth: document.depth,
			links: document.links?.total,
			bytes: document.measurements?.bytes,
			lines: document.measurements?.lines,
			headings: document.measurements?.headings,
			repeatedParagraphs: document.measurements?.repeatedParagraphs?.extraOccurrences,
			repeatedHeadings: document.measurements?.repeatedHeadings?.extraOccurrences,
			repeatedReferences: document.measurements?.repeatedReferences?.extraOccurrences,
			checks: document.checks,
			limitations: Object.fromEntries(Object.entries(document.limitations).map(([key, value]) => [key, value.count]))
		} : null;
		const before = describe(beforeDocs.get(path));
		const after = describe(afterDocs.get(path));
		return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after)) ? [] : [{
			path,
			before,
			after
		}];
	});
	return {
		schemaVersion: 1,
		scope: before.scope.path,
		summary: {
			introduced: introduced.length,
			unchanged: unchanged.length,
			modified: modified.length,
			cleared: cleared.length,
			unverified: unverified.length,
			changedDocuments: documents.length
		},
		findings: {
			introduced,
			unchanged,
			modified,
			cleared,
			unverified
		},
		documents
	};
}
// src/analysis/inventory.ts
function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}
function referenceKey(reference) {
	const fields = [
		reference.kind,
		reference.value,
		reference.npmPrefix,
		reference.claim,
		reference.packageLabel,
		reference.packageRow?.label
	];
	if (reference.workingDirectory !== void 0 || reference.shorthand !== void 0) fields.push(reference.workingDirectory, reference.shorthand);
	if (reference.version !== void 0) fields.push(reference.version);
	if (reference.workspace) fields.push(reference.workspace.manager, reference.workspace.name);
	return digest(JSON.stringify(fields));
}
function note(document, { reason, ...example }) {
	const entry = document.limitations[reason] ?? {
		count: 0,
		examples: []
	};
	entry.count++;
	if (entry.examples.length < 5) entry.examples.push(example);
	document.limitations[reason] = entry;
}
// src/parsers/script-command.ts
const scriptName = /^[a-z0-9_][\w:.-]*$/i;
const otherManager = /^(?:pnpm|yarn|bun|vp)\s+run\s+([a-z0-9_][\w:.-]*)(?=$|\s|[;&|])/i;
const shorthandTask = /^(?:pnpm|yarn)\s+(?:build|lint|test|typecheck)(?:[-:][a-z0-9_][\w:.-]*)?(?=$|\s|[;&|])/;
const workspaceTask = /^(?:(?:build|check|lint|test|typecheck)(?:[-:][a-z0-9_][\w:.-]*)?|prepublishOnly)$/;
const workspaceName = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const assignments = /^(?:[A-Za-z_][\w]*=[A-Za-z0-9_./:-]*[ \t]+)+/;
const changeDirectory = /^cd[ \t]+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))[ \t]*&&[ \t]*/;
const literalPath = /^[\p{L}\p{N}_. /-]+$/u;
const word = /(?:'[^']*'|"[^"]*"|[^\s'"|;&<>()\\])+/y;
function words(command) {
	const tokens = [];
	let rest = command.trimStart().replace(/^\$\s+/, "");
	while (rest && !/^[|;&<>()#]/.test(rest)) {
		word.lastIndex = 0;
		const match = word.exec(rest);
		if (!match) return null;
		const token = match[0];
		const tail = rest.slice(token.length);
		if (/^['"\\]/.test(tail)) return null;
		rest = tail.trimStart();
		tokens.push(token.replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double));
		if (tokens.at(-1) === "--") break;
	}
	return tokens;
}
function workspaceCommand(invocation) {
	if (!/^(?:yarn\s+workspace\s|pnpm\s+(?:--filter[=\s]|-F\s))/.test(invocation)) return null;
	const [manager, selector, ...args] = words(invocation) ?? [];
	const target = selector?.startsWith("--filter=") ? selector.slice(9) : args.shift();
	const run = args[0] === "run" || manager === "pnpm" && args[0] === "run-script";
	const name = args[run ? 1 : 0];
	if (manager !== "pnpm" && manager !== "yarn" || !target || !workspaceName.test(target) || target.includes("...") || !name || !(run ? scriptName : workspaceTask).test(name) || args.slice(run ? 2 : 1).some((argument) => /^(?:-F|--filter(?:-prod)?|--if-present)(?:=|$)/.test(argument))) return null;
	return {
		name,
		workspace: {
			manager,
			name: target
		},
		...!run ? { shorthand: manager } : {}
	};
}
function scriptCommand(command) {
	let invocation = command.trimStart().replace(/^\$\s+/, "").replace(assignments, "");
	const directory = changeDirectory.exec(invocation);
	const workingDirectory = directory?.[1] ?? directory?.[2] ?? directory?.[3];
	if (directory && workingDirectory) {
		if (!literalPath.test(workingDirectory) || /^[/ -]/.test(workingDirectory)) return null;
		invocation = invocation.slice(directory[0].length).replace(assignments, "");
	}
	if (!workingDirectory) {
		const workspace = workspaceCommand(invocation);
		if (workspace) return workspace;
	}
	const scope = workingDirectory === void 0 ? {} : { workingDirectory };
	const other = otherManager.exec(invocation);
	if (other) return {
		name: other[1],
		...scope
	};
	const shorthand = shorthandTask.exec(invocation);
	if (shorthand) {
		const [manager, name] = shorthand[0].split(/\s+/);
		return {
			name,
			shorthand: manager === "pnpm" ? "pnpm" : "yarn",
			...scope
		};
	}
	if (!/^npm(?=\s)/.test(invocation)) return null;
	const tokens = words(invocation)?.slice(1);
	if (!tokens) return null;
	let name;
	let npmPrefix;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--") break;
		if (/^(?:-w|--workspaces?|--include-workspace-root|-g|--global)(?:=|$)/.test(token)) return null;
		if (token === "--prefix" || token.startsWith("--prefix=")) {
			if (npmPrefix !== void 0 || workingDirectory !== void 0) return null;
			npmPrefix = token === "--prefix" ? tokens[++index] : token.slice(9);
			if (!npmPrefix || !literalPath.test(npmPrefix) || npmPrefix.startsWith("-")) return null;
		} else if (name === void 0) {
			if (token === "run" || token === "run-script") name = tokens[++index];
			else if (token === "test") name = token;
			else return null;
			if (!name || !scriptName.test(name)) return null;
		}
	}
	return name ? {
		name,
		...scope,
		...npmPrefix === void 0 ? {} : { npmPrefix }
	} : null;
}
function looksLikePackageCommand(value) {
	return /(?:^|&&[ \t]+|=[^\s]*[ \t]+)(?:\$[ \t]+)?(?:npm|pnpm|yarn|bun|vp)[ \t]+/.test(value.trimStart());
}
function mutatingLintFlag(command) {
	const wordsInCommand = words(command);
	if (!wordsInCommand) return void 0;
	const [tool, ...args] = wordsInCommand;
	if (!/^(?:stylelint|eslint|oxlint)$/.test(tool)) return void 0;
	return args.includes("--fix") ? "--fix" : null;
}
// src/parsers/markdown.ts
function walk(node, visit, previous, next, row) {
	visit(node, previous, next, row);
	if ("children" in node) {
		const children = node.children;
		children.forEach((child, index) => walk(child, visit, children[index - 1], children[index + 1], node.type === "tableRow" ? node : row));
	}
}
function headingText(node) {
	if (node.type === "image") return node.alt ?? "";
	if (node.type === "html") return "";
	if ("value" in node) return node.value;
	if ("children" in node) return node.children.map(headingText).join("");
	return "";
}
const shell = /^(?:sh|shell|bash|zsh|console|shell-session)$/i;
const packageManagerLabel = /^(?:\*\*|__)?(?:required[ \t]+)?package[ -]manager(?:\*\*|__)?[ \t]*:[ \t]*`?(?<manager>npm|pnpm|yarn|bun)(?:(?:@|[ \t]+)v?(?<version>\d+\.\d+\.\d+(?:-[\w.-]+)?))?`?(?:[ \t]+\(required\))?\.?[ \t]*$/di;
const packageManagerDirective = /^(?:always[ \t]+)?use[ \t]+`?(?<manager>npm|pnpm|yarn|bun)`?[ \t]+for[ \t]+(?:package|dependency) management\.?[ \t]*$/di;
const packageManagerRequirement = /(?:^|[.!?][ \t]+)(?:the[ \t]+)?package manager(?: used to install and link dependencies)? must be[ \t]+`?\[?(?<manager>npm|pnpm|yarn|bun)(?:\]\([^\n)]+\)|`)?(?=\.(?:\s|$)|$)/di;
const dependency$1 = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i;
const nodeVersion = /\bnode(?:\.js)?[ \t]+(v?\d+(?:\.\d+){0,2})(?![\dA-Za-z/+-]|\.\w|\s*(?:\bor\b|\bthrough\b|\bto\b|\band\s+(?:above|later|newer)\b|[,/]\s*v?\d))/gi;
const nodeMinimum$1 = /\bnode(?:\.js)?[ \t]+(v?\d+(?:\.\d+){0,2})\+(?!\w|\.\d)/gi;
const fileName = /^[\w.-]+\.(?:md|markdown|[cm]?[jt]sx?|vue|svelte|jsonc?|ya?ml|toml|py|go|rb|rs|cs|sh|css|sql|html|txt)$/i;
const versionOnly = /^v?\d+(?:\.\d+){0,2}$/;
function looksLikePath(value) {
	if (/^\.d\.[cm]?ts$/.test(value) || value.split("/").includes("...")) return false;
	if (/[\n\r\t\\*?<>|{}$]/.test(value)) return false;
	if (/^\.\.?\/[\w. -]/.test(value)) return true;
	const parts = value.replace(/\/$/, "").split("/");
	return parts.length === 1 && (isConfiguration(value) || fileName.test(value) || /^[\w.-]+\/$/.test(value)) || parts.length > 1 && !parts.every((part) => /^\d+$/.test(part)) && parts.every((part) => /^[\w.-]+$/.test(part));
}
function repetitions(entries) {
	const repeated = [...entries.values()].filter((entry) => entry.occurrences > 1);
	return {
		groups: repeated.length,
		extraOccurrences: repeated.reduce((total, entry) => total + entry.occurrences - 1, 0),
		examples: repeated.slice(0, 10)
	};
}
function count(entries, value, line) {
	const entry = entries.get(value) ?? {
		lines: [],
		occurrences: 0
	};
	if (entry.lines.length < 5) entry.lines.push(line);
	entry.occurrences++;
	entries.set(value, entry);
}
function parseMarkdown(contents, inventory = false) {
	const tree = fromMarkdown(contents, {
		extensions: [frontmatter(["yaml", "toml"]), gfm()],
		mdastExtensions: [frontmatterFromMarkdown(["yaml", "toml"]), gfmFromMarkdown()]
	});
	const definitions = /* @__PURE__ */ new Map();
	const anchors = /* @__PURE__ */ new Set();
	const slugger = new GithubSlugger();
	const references = [];
	const notices = [];
	const headings = /* @__PURE__ */ new Map();
	const paragraphs = /* @__PURE__ */ new Map();
	let historical;
	walk(tree, (node) => {
		if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
		if (node.type === "heading") {
			const heading = headingText(node);
			anchors.add(slugger.slug(heading));
			if (inventory && node.position) count(headings, heading.trim(), node.position.start.line);
		}
		if (inventory && node.type === "paragraph" && node.position) {
			const paragraph = contents.slice(node.position.start.offset, node.position.end.offset).replace(/\s+/g, " ").trim();
			if (paragraph) count(paragraphs, createHash("sha256").update(paragraph).digest("hex"), node.position.start.line);
		}
		if (node.type === "html") for (const match of node.value.matchAll(/<[a-z][\w-]*\b[^>]*?\s(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]);
	});
	walk(tree, (node, previous, next, row) => {
		const start = node.position?.start;
		if (!start) return;
		const add = (kind, value, line = start.line, column = start.column) => {
			if (value && value.length <= 4096) references.push({
				kind,
				value,
				line,
				column
			});
		};
		if (node.type === "paragraph") {
			const paragraph = contents.slice(start.offset, node.position?.end.offset).trimEnd();
			const requirement = packageManagerLabel.exec(paragraph) ?? packageManagerDirective.exec(paragraph) ?? packageManagerRequirement.exec(paragraph);
			const managerStart = requirement?.indices?.groups?.manager?.[0];
			if (requirement?.groups?.manager && managerStart !== void 0) {
				const { manager, version } = requirement.groups;
				const preceding = paragraph.slice(0, managerStart).split(/\r\n|\r|\n/);
				references.push({
					kind: "package-manager",
					value: manager.toLowerCase(),
					...version ? { version } : {},
					line: start.line + preceding.length - 1,
					column: (preceding.length === 1 ? start.column : 1) + (preceding.at(-1)?.length ?? 0)
				});
			}
		}
		if (node.type === "yaml") {
			const lineCounter = new LineCounter();
			const metadata = parseDocument(node.value, { lineCounter });
			if (metadata.errors.length) {
				if (inventory) notices.push({
					reason: "invalid-yaml-frontmatter",
					line: start.line
				});
				return;
			}
			if (metadata.get("immutable") === true) {
				const revision = metadata.get("revision");
				historical = typeof revision === "string" && revision.length <= 128 ? { revision } : {};
			}
			const sources = metadata.get("sources", true);
			if (isSeq(sources)) for (const item of sources.items) {
				if (!isScalar(item) || typeof item.value !== "string" || !item.range) continue;
				const location = lineCounter.linePos(item.range[0]);
				add("wiki-source", item.value, start.line + location.line, location.col);
			}
		}
		if (inventory && node.type === "toml") notices.push({
			reason: "toml-frontmatter-uninterpreted",
			line: start.line
		});
		const addScript = (value, line, column, command = scriptCommand(value), example = false) => {
			if (!command) {
				if (inventory && looksLikePackageCommand(value)) notices.push({
					reason: "package-command-outside-script-parser",
					line
				});
				return false;
			}
			const packageRow = row?.type === "tableRow" && row.position ? {
				line: row.position.start.line,
				label: headingText(row.children[0]).trim()
			} : void 0;
			const { name, ...invocation } = command;
			references.push({
				kind: invocation.workspace ? "workspace-script" : "script",
				value: name,
				...invocation,
				...invocation.workspace && example ? { workspaceExample: true } : {},
				packageRow,
				line,
				column
			});
			return true;
		};
		if (node.type === "link" || node.type === "image") add("link", node.url);
		if (node.type === "linkReference" || node.type === "imageReference") {
			const url = definitions.get(node.identifier);
			if (url) add("link", url);
		}
		if (node.type === "code" && shell.test(node.lang ?? "") && !/\bexample\b/i.test(node.meta ?? "")) {
			const introduction = previous?.type === "paragraph" ? headingText(previous).trim() : "";
			const example = introduction.endsWith(":") && /^(?:examples?\s*:|for example\b)/i.test(introduction);
			node.value.split("\n").forEach((line, index) => {
				addScript(line.trimStart(), start.line + index + 1, line.length - line.trimStart().length + 1, void 0, example);
			});
		}
		if (node.type === "inlineCode") {
			const prefix = previous?.type === "text" ? previous.value : "";
			const suffix = next?.type === "text" ? next.value : "";
			const claim = /^\s+is\s+(non-mutating|read-only)\b/i.exec(suffix)?.[1];
			const command = scriptCommand(node.value);
			if (claim && !command?.workspace && (command || /^[a-z0-9_][\w:.-]*$/i.test(node.value))) {
				const { name = node.value, ...invocation } = command ?? {};
				references.push({
					kind: "script-claim",
					value: name,
					...invocation,
					claim,
					line: start.line,
					column: start.column
				});
			}
			const example = /\b(?:for example|e\.g\.)[, \t]*$/i.test(prefix);
			if (addScript(node.value, start.line, start.column, command, example)) return;
			if (dependency$1.test(node.value) && (/\bdependenc(?:y|ies):\s*$/i.test(prefix) || /\brequires?\s+(?:the\s+)?$/i.test(prefix) && /^\s+package\b/i.test(suffix))) add("dependency", node.value);
			else if (versionOnly.test(node.value) && /\bnode(?:\.js)?[ \t]+$/i.test(prefix) && !/^\s*(?:\+|or\b|through\b|to\b|and\s+(?:above|later|newer)\b|[,/]\s*v?\d)/i.test(suffix)) add("node", node.value);
			else if (looksLikePath(node.value) && !/\b(?:creates?|generates?|writes?|auto-adds?)\s+(?:(?:an?|the)\s+)?(?:empty\s+)?$/i.test(prefix) && !/^\s+is\s+generated\b/i.test(suffix)) add("path", node.value);
		}
		if (node.type === "text" || node.type === "inlineCode") {
			for (const match of node.value.matchAll(nodeMinimum$1)) {
				const lines = node.value.slice(0, match.index).split("\n");
				const preceding = lines.at(-1) ?? "";
				const requirement = /^\s*([A-Za-z][\w-]*(?: [A-Za-z][\w-]*){0,2})\s+(?:requires?|needs?)\s+$/i.exec(preceding);
				if (!requirement) continue;
				references.push({
					kind: "node-minimum",
					value: match[1],
					packageLabel: requirement[1],
					line: start.line + lines.length - 1,
					column: (lines.length === 1 ? start.column : 1) + preceding.length
				});
			}
			for (const match of node.value.matchAll(nodeVersion)) {
				const lines = node.value.slice(0, match.index).split("\n");
				const line = start.line + lines.length - 1;
				const column = (lines.length === 1 ? start.column : 1) + (lines.at(-1)?.length ?? 0);
				add("node", match[1], line, column);
			}
		}
	});
	let measurements;
	if (inventory) {
		const values = /* @__PURE__ */ new Map();
		for (const reference of references) count(values, JSON.stringify([
			reference.kind,
			reference.value,
			reference.npmPrefix,
			reference.workingDirectory,
			reference.shorthand,
			reference.version,
			reference.workspace?.manager,
			reference.workspace?.name
		]), reference.line);
		measurements = {
			bytes: Buffer.byteLength(contents),
			lines: contents ? contents.split(/\r\n|\r|\n/).length - Number(/[\r\n]$/.test(contents)) : 0,
			headings: [...headings.values()].reduce((total, entry) => total + entry.occurrences, 0),
			repeatedHeadings: repetitions(headings),
			repeatedParagraphs: repetitions(paragraphs),
			repeatedReferences: repetitions(values)
		};
	}
	return {
		anchors,
		references,
		historical,
		notices,
		measurements
	};
}
// src/resolvers/workspace.ts
function parsePatterns(entries) {
	if (!Array.isArray(entries)) return void 0;
	const patterns = [];
	for (const entry of entries) {
		if (typeof entry !== "string") return void 0;
		const exclude = entry.startsWith("!");
		const name = entry.slice(Number(exclude)).replace(/^\.\//, "").replace(/\/$/, "");
		const segments = name === "." ? [] : name.split("/");
		if (!segments.every((segment) => segment !== "." && segment !== ".." && /^(?:\*{1,2}|[\p{L}\p{N}_.@+-]+)$/u.test(segment))) return void 0;
		patterns.push({
			exclude,
			segments
		});
	}
	return patterns;
}
function matches(pattern, directory) {
	let positions = /* @__PURE__ */ new Set([0]);
	for (const segment of pattern) {
		if (segment === "**") for (const position of positions) {
			const next = directory[position];
			if (next && !next.startsWith(".")) positions.add(position + 1);
		}
		else positions = new Set([...positions].filter((position) => {
			const next = directory[position];
			return next === segment || segment === "*" && next && !next.startsWith(".");
		}).map((position) => position + 1));
		if (!positions.size) return false;
	}
	return positions.has(directory.length);
}
async function pnpmDefinition(tree, directory) {
	const path = resolve(directory, "pnpm-workspace.yaml");
	if (!await tree.locate(path)) return null;
	const input = await tree.read(path);
	if (input === null) return {
		path,
		issue: "workspace-definition-unavailable"
	};
	const parsed = parseDocument(input);
	if (parsed.errors.length || !isMap(parsed.contents)) return {
		path,
		issue: "workspace-definition-invalid"
	};
	const packages = parsed.get("packages", true);
	if (packages === void 0) return {
		path,
		patterns: []
	};
	if (!isSeq(packages)) return {
		path,
		issue: "workspace-definition-invalid"
	};
	const entries = packages.items.map((entry) => isScalar(entry) ? entry.value : void 0);
	if (entries.some((entry) => typeof entry !== "string")) return {
		path,
		issue: "workspace-definition-invalid"
	};
	const patterns = parsePatterns(entries);
	return patterns ? {
		path,
		patterns
	} : {
		path,
		issue: "workspace-pattern-unsupported"
	};
}
async function yarnDefinition(tree, directory) {
	const path = resolve(directory, "package.json");
	const location = await tree.locate(path);
	if (!location) return null;
	if (location.kind !== "file") return {
		path,
		issue: "workspace-definition-unavailable"
	};
	const manifest = await tree.manifestAt(directory);
	if (!manifest?.data) return {
		path,
		issue: "workspace-definition-invalid"
	};
	const { workspaces } = manifest.data;
	if (workspaces === void 0) return null;
	const patterns = parsePatterns(isRecord(workspaces) ? workspaces.packages : workspaces);
	return patterns ? {
		path: manifest.path,
		patterns
	} : {
		path: manifest.path,
		issue: "workspace-pattern-unsupported"
	};
}
function workspaceResolver(tree, discoverManifests) {
	const definitions = /* @__PURE__ */ new Map();
	const members = /* @__PURE__ */ new Map();
	let manifestPaths;
	async function inspectMembers(definition, manager) {
		const workspace = dirname(definition.path);
		const { patterns } = definition;
		const includes = (relative) => {
			const manifest = resolve(tree.root, relative);
			const directory = dirname(manifest);
			if (!within(workspace, directory)) return false;
			if (directory === workspace) return manager === "pnpm";
			const segments = displayPath(workspace, directory).split("/");
			return patterns.some((pattern) => !pattern.exclude && matches(pattern.segments, segments)) && !patterns.some((pattern) => pattern.exclude && matches(pattern.segments, segments));
		};
		manifestPaths ??= discoverManifests();
		const paths = (await manifestPaths).filter(includes);
		const manifests = [];
		let incomplete = false;
		for (const relative of paths) {
			const path = resolve(tree.root, relative);
			const location = await tree.locate(path);
			if (!location) continue;
			if (location.kind !== "file" || !within(workspace, location.path)) {
				incomplete = true;
				continue;
			}
			const manifest = await tree.manifestAt(dirname(path));
			if (manifest?.data) manifests.push(manifest);
			else incomplete = true;
		}
		return {
			manifests,
			incomplete
		};
	}
	return async (file, selector) => {
		const { manager, name } = selector;
		let definition = null;
		for (const directory of tree.ancestors(file)) {
			const key = JSON.stringify([manager, directory]);
			let cached = definitions.get(key);
			if (!cached) {
				cached = manager === "pnpm" ? pnpmDefinition(tree, directory) : yarnDefinition(tree, directory);
				definitions.set(key, cached);
			}
			definition = await cached;
			if (definition) break;
		}
		if (!definition) return { issue: "workspace-definition-missing" };
		if ("issue" in definition) return {
			issue: definition.issue,
			path: definition.path
		};
		let cached = members.get(definition.path);
		if (!cached) {
			cached = inspectMembers(definition, manager);
			members.set(definition.path, cached);
		}
		const { manifests, incomplete } = await cached;
		let matches = manifests.filter((manifest) => manifest.data?.name === name);
		if (!matches.length && manager === "pnpm" && !name.startsWith("@")) matches = manifests.filter(({ data }) => typeof data?.name === "string" && data.name.startsWith("@") && data.name.split("/").at(-1) === name);
		if (incomplete && matches.length < 2) return {
			issue: "workspace-manifests-incomplete",
			path: definition.path
		};
		return {
			definition: definition.path,
			matches,
			inspectedCount: manifests.length
		};
	};
}
// src/rules/index.ts
const link = {
	id: "broken-markdown-link",
	alias: "CD001",
	kind: "link",
	severity: "error",
	description: "Check repository-local Markdown destinations and heading anchors.",
	guidance: "Inspect the destination and confirm which page or section the author intended to reference.",
	async check(reference, { file, tree, markdown, skip, inventory }) {
		const target = localTarget(file, tree.root, reference.value, true);
		if (!target) return skip("link-target-outside-local-resolution");
		const entry = await tree.locate(target.path);
		if (entry?.kind === "other") return skip("link-target-unavailable", target.path);
		const path = displayPath(tree.root, target.path);
		const evidence = {
			reference: inventory ? reference.value.replace(/^([^?#]*)\?[^#]*/, "$1") : reference.value,
			resolvedPath: path,
			exists: Boolean(entry)
		};
		if (!entry) return {
			paths: [path],
			evidence
		};
		if (entry.kind !== "file" || !target.fragment || !isMarkdown(target.path) || /^L\d+(?:-L\d+)?$/.test(target.fragment)) return null;
		const destination = await markdown(target.path);
		if (!destination) return skip("anchor-target-unreadable", target.path);
		if (!destination.anchors.has(target.fragment)) return {
			paths: [path],
			evidence: {
				...evidence,
				fragment: target.fragment,
				anchorExists: false
			}
		};
		return null;
	}
};
const path = {
	id: "reference-not-found",
	alias: "CD002",
	kind: "path",
	severity: "warning",
	description: "Check inline code that looks like a repository file, directory, or configuration path.",
	guidance: "Check whether the reference is illustrative, generated, renamed, or removed. Confirm the intended location before editing.",
	async check(reference, { file, tree, pathCandidates, packageCandidates, isIgnored, indexedPath, skip }) {
		const target = localTarget(file, tree.root, reference.value, false);
		if (!target) return skip("path-outside-local-resolution");
		const explicit = reference.value.startsWith("./") || reference.value.startsWith("../");
		const config = isConfiguration(reference.value) && !reference.value.includes("/");
		const paths = config ? [...tree.ancestors(file)].map((directory) => resolve(directory, reference.value)) : [.../* @__PURE__ */ new Set([target.path, ...!explicit ? [resolve(tree.root, reference.value)] : []])];
		const entries = await Promise.all(paths.map((candidate) => tree.locate(candidate)));
		const expectsDirectory = reference.value.endsWith("/");
		if (entries.some((entry) => entry && entry.kind !== "other" && (!expectsDirectory || entry.kind === "directory"))) return null;
		const other = entries.find((entry) => entry?.kind === "other");
		if (other) return skip("path-target-unavailable", other.path);
		if (!config && !reference.value.includes("/") && isMarkdown(reference.value)) {
			const scoped = await indexedPath(reference.value, reference.line, reference.column);
			if (scoped) {
				const entry = await tree.locate(scoped.path);
				if (entry?.kind === "file") return null;
				if (entry?.kind === "other") return skip("path-target-unavailable", scoped.path);
				const location = displayPath(tree.root, scoped.path);
				const index = displayPath(tree.root, scoped.index);
				return {
					confidence: "medium",
					paths: [location, index],
					evidence: {
						reference: reference.value,
						resolvedPath: location,
						exists: Boolean(entry),
						documentIndex: index,
						documentIndexReferenceLine: scoped.line,
						...entry ? {
							expectedKind: "file",
							actualKind: entry.kind
						} : {}
					}
				};
			}
		}
		if (entries.every((entry) => !entry) && !explicit) {
			const [name, ...segments] = reference.value.split("/");
			if (["node_modules/", "dist/"].includes(reference.value) && await isIgnored(reference.value)) return skip("git-ignored-generated-directory");
			if (segments.length && !expectsDirectory) for (const candidate of await packageCandidates(name)) {
				const manifest = await tree.manifestAt(dirname(resolve(tree.root, candidate)));
				const exports = manifest?.data?.exports;
				if (manifest?.data?.name === name && exports && typeof exports === "object" && Object.hasOwn(exports, "./" + segments.join("/"))) return null;
			}
		}
		const checked = paths.map((candidate) => displayPath(tree.root, candidate));
		const wrongKind = entries.findIndex((entry) => entry?.kind === "file");
		const suffix = reference.value.replace(/\/$/, "");
		const sourceDirectory = displayPath(tree.root, dirname(file));
		return {
			candidates: explicit ? [] : suffix.includes("/") ? await pathCandidates(suffix, expectsDirectory) : !config && !expectsDirectory && sourceDirectory !== "." && suffix.includes(".") ? await pathCandidates(suffix, false, sourceDirectory) : [],
			confidence: explicit ? "high" : "medium",
			paths: checked,
			evidence: {
				reference: reference.value,
				resolvedPath: checked[wrongKind < 0 ? 0 : wrongKind],
				exists: wrongKind >= 0,
				...checked.length > 1 ? { checkedPaths: checked } : {},
				...wrongKind >= 0 ? {
					expectedKind: "directory",
					actualKind: "file"
				} : {}
			}
		};
	}
};
async function scriptManifests(tree, file, { npmPrefix, workingDirectory }) {
	const prefix = npmPrefix ?? workingDirectory;
	const directories = prefix === void 0 ? [...tree.ancestors(file)] : [.../* @__PURE__ */ new Set([resolve(tree.root, prefix), resolve(dirname(file), prefix)])].filter((path) => within(tree.root, path));
	return {
		manifests: (prefix === void 0 ? [await tree.manifest(file)] : await Promise.all(directories.map((path) => tree.manifestAt(path)))).filter((manifest) => manifest !== null),
		paths: directories.map((path) => displayPath(tree.root, resolve(path, "package.json")))
	};
}
const dependencySections = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies"
];
async function hasExecutableEvidence(tree, manifest, name) {
	for (const directory of tree.ancestors(manifest.path)) {
		const candidate = await tree.manifestAt(directory);
		if (dependencySections.some((section) => Object.keys(candidate?.data?.[section] ?? {}).some((dependency) => dependency.split("/").at(-1) === name))) return true;
		if (!name.includes(":")) {
			const bin = resolve(directory, "node_modules", ".bin", name);
			if (await tree.locate(bin)) return true;
			if (process.platform === "win32" && await tree.locate(bin + ".cmd")) return true;
		}
	}
	return false;
}
const unknownScriptScope = {
	id: "script-scope-unknown",
	alias: "CD006",
	severity: "warning",
	description: "Identify script commands whose owning package could not be established.",
	guidance: "Identify the intended working directory before validating this script."
};
const unresolvedShorthand = {
	id: "script-shorthand-unresolved",
	alias: "CD010",
	severity: "warning",
	description: "Identify a Yarn or pnpm task shorthand that is absent from the selected manifest.",
	guidance: "Check whether the shorthand is meant to run a package script or an executable provided by the package manager."
};
async function checkManifestScript(reference, { tree, skip }, manifest, evidence, relatedPaths = []) {
	const scripts = Object.keys(manifest.data?.scripts ?? {}).sort();
	if (scripts.includes(reference.value)) return null;
	const { shorthand, workspace } = reference;
	const isYarn = shorthand === "yarn" || workspace?.manager === "yarn";
	if (isYarn && reference.value.includes(":")) return skip("yarn-workspace-script-unchecked", manifest.path);
	if (workspace?.manager === "yarn" && reference.value === "env") return skip("yarn-command-outside-script-check", manifest.path);
	if ((shorthand || isYarn) && await hasExecutableEvidence(tree, manifest, reference.value)) return skip("shorthand-executable-candidate", manifest.path);
	const manifestPath = displayPath(tree.root, manifest.path);
	return {
		paths: [manifestPath, ...relatedPaths],
		...shorthand ? {
			confidence: "medium",
			diagnostic: unresolvedShorthand
		} : {},
		evidence: {
			...evidence,
			manifest: manifestPath,
			defined: false,
			availableScripts: scripts.slice(0, 15),
			availableScriptCount: scripts.length
		}
	};
}
const script = {
	id: "script-not-defined",
	alias: "CD003",
	kind: "script",
	severity: "error",
	description: "Check script commands against the selected package manifest.",
	guidance: "Inspect the package and instructions to confirm which script or working directory the author intended.",
	async check(reference, { file, tree, packageCandidates, skip, inventory }) {
		const { npmPrefix, workingDirectory, shorthand } = reference;
		const { manifests, paths } = await scriptManifests(tree, file, reference);
		if (!paths.length) return skip("script-prefix-outside-repository");
		const evidence = {
			script: reference.value,
			...npmPrefix === void 0 ? {} : { npmPrefix },
			...workingDirectory === void 0 ? {} : { workingDirectory },
			...shorthand === void 0 ? {} : {
				packageManager: shorthand,
				commandForm: "shorthand"
			},
			...inventory ? {
				manifestStrategy: workingDirectory !== void 0 ? "literal-working-directory" : npmPrefix !== void 0 ? "literal-prefix" : "nearest-ancestor",
				searchedManifests: paths
			} : {}
		};
		if (manifests.length !== 1 || !manifests[0].data) {
			const invalid = manifests.find((manifest) => manifest.issue);
			skip(invalid?.issue ? "manifest-" + invalid.issue : manifests.length ? "manifest-ambiguous" : "manifest-missing", invalid?.path);
			if (shorthand) return null;
			return {
				paths,
				confidence: "medium",
				diagnostic: unknownScriptScope,
				evidence: {
					...evidence,
					manifest: null,
					checkedManifests: paths,
					candidateManifests: manifests.length ? manifests.map(({ path }) => displayPath(tree.root, path)) : npmPrefix === void 0 && workingDirectory === void 0 && reference.packageRow ? await packageCandidates(reference.packageRow.label) : []
				}
			};
		}
		return checkManifestScript(reference, {
			tree,
			skip
		}, manifests[0], evidence);
	}
};
const workspaceScript = {
	id: "workspace-target-unresolved",
	alias: "CD013",
	kind: "workspace-script",
	severity: "warning",
	description: "Check whether a named pnpm or Yarn target resolves to one declared workspace.",
	guidance: "Verify the package name and membership in the workspace declared by the repository.",
	async check(reference, { file, tree, resolveWorkspace, skip }) {
		const selector = reference.workspace;
		if (!selector) return null;
		const result = await resolveWorkspace(file, selector);
		if ("issue" in result) return skip(result.issue, result.path);
		const definition = displayPath(tree.root, result.definition);
		const evidence = {
			script: reference.value,
			packageManager: selector.manager,
			workspace: selector.name,
			workspaceDefinition: definition,
			manifestStrategy: "named-workspace",
			commandForm: reference.shorthand ? "shorthand" : "run"
		};
		if (result.matches.length === 1) {
			const finding = await checkManifestScript(reference, {
				tree,
				skip
			}, result.matches[0], evidence, [definition]);
			return finding ? {
				...finding,
				diagnostic: finding.diagnostic ?? script
			} : null;
		}
		if (reference.workspaceExample) return skip("illustrative-workspace-target", result.definition);
		const matchingManifests = result.matches.map(({ path }) => displayPath(tree.root, path));
		return {
			confidence: "medium",
			paths: [definition, ...matchingManifests],
			evidence: {
				...evidence,
				matchingManifests: matchingManifests.slice(0, 5),
				workspaceMatchCount: matchingManifests.length,
				inspectedCount: result.inspectedCount
			}
		};
	}
};
const dependency = {
	id: "dependency-not-declared",
	alias: "CD004",
	kind: "dependency",
	severity: "warning",
	description: "Check explicitly named packages against the nearest manifest's dependency sections.",
	guidance: "Confirm whether this package should be declared here, is provided by another workspace package, or is an external prerequisite.",
	async check(reference, { file, tree, skip }) {
		const manifest = await tree.manifest(file);
		if (!manifest?.data) return skip(manifest?.issue ? "manifest-" + manifest.issue : "manifest-missing", manifest?.path);
		if (dependencySections.some((section) => Object.hasOwn(manifest.data?.[section] ?? {}, reference.value))) return null;
		const path = displayPath(tree.root, manifest.path);
		return {
			paths: [path],
			evidence: {
				package: reference.value,
				manifest: path,
				declared: false,
				checkedSections: dependencySections
			}
		};
	}
};
const runtime = {
	id: "node-version-mismatch",
	alias: "CD005",
	kind: "node",
	severity: "warning",
	description: "Compare an explicitly mentioned Node.js version with repository pins or engines.node.",
	guidance: "Confirm which Node.js version the repository intends to use and whether the mention is an instruction or historical context.",
	async check(reference, { file, tree, skip }) {
		const manifest = await tree.manifest(file);
		const pinned = [];
		for (const directory of tree.ancestors(file)) {
			for (const name of [".node-version", ".nvmrc"]) {
				const path = resolve(directory, name);
				const version = (await tree.read(path))?.split("#")[0].trim();
				if (version && /^v?\d+(?:\.\d+){0,2}$/.test(version)) pinned.push({
					path,
					version
				});
			}
			if (pinned.length) break;
			const volta = manifest?.data?.volta?.node;
			if (manifest && directory === dirname(manifest.path) && typeof volta === "string" && validRange(volta)) {
				pinned.push({
					path: manifest.path,
					version: volta
				});
				break;
			}
		}
		const engine = manifest?.data?.engines?.node;
		if (!pinned.length && manifest && typeof engine === "string" && validRange(engine)) pinned.push({
			path: manifest.path,
			version: engine
		});
		if (!pinned.length) return skip(manifest?.issue ? "manifest-" + manifest.issue : "node-version-evidence-missing", manifest?.path);
		const incompatible = pinned.filter(({ version }) => !intersects(version, reference.value)).map(({ path, version }) => ({
			file: displayPath(tree.root, path),
			version
		}));
		if (!incompatible.length) return null;
		return {
			paths: incompatible.map(({ file }) => file),
			confidence: "medium",
			evidence: {
				documentedVersion: reference.value,
				incompatible
			}
		};
	}
};
const scriptClaim = {
	id: "script-mutates-files",
	alias: "CD008",
	kind: "script-claim",
	severity: "error",
	description: "Check explicit read-only or non-mutating claims against supported linter commands.",
	guidance: "Confirm the intended behavior, then correct the script or the read-only claim.",
	async check(reference, { file, tree, markdown, skip, inventory }) {
		const commands = (await markdown(file))?.references ?? [];
		const related = commands.filter((command) => command.kind === "script" && command.value === reference.value && (command.npmPrefix !== void 0 || command.workingDirectory !== void 0));
		if (reference.npmPrefix === void 0 && reference.workingDirectory === void 0 && !related.length && commands.some((command) => command.kind === "workspace-script" && command.value === reference.value)) return skip("workspace-script-claim-unsupported");
		const locations = reference.npmPrefix !== void 0 || reference.workingDirectory !== void 0 || !related.length ? [reference] : related;
		const manifests = /* @__PURE__ */ new Map();
		for (const location of locations) {
			const { manifests: choices } = await scriptManifests(tree, file, location);
			if (choices.length !== 1 || !choices[0].data) {
				const invalid = choices.find((manifest) => manifest.issue);
				return skip(invalid?.issue ? "manifest-" + invalid.issue : choices.length ? "manifest-ambiguous" : "manifest-missing", invalid?.path);
			}
			manifests.set(choices[0].path, choices[0]);
		}
		if (manifests.size !== 1) return skip("manifest-ambiguous");
		const manifest = [...manifests.values()][0];
		const body = manifest.data?.scripts?.[reference.value];
		if (typeof body !== "string") return skip("script-body-unavailable", manifest.path);
		const flag = mutatingLintFlag(body);
		if (flag === void 0) return skip("lint-command-outside-read-only-check", manifest.path);
		if (!flag) return null;
		const path = displayPath(tree.root, manifest.path);
		return {
			paths: [path],
			evidence: {
				claim: reference.claim,
				script: reference.value,
				manifest: path,
				manifestPointer: "/scripts/" + reference.value,
				...inventory ? { bodyDigest: createHash("sha256").update(body).digest("hex") } : { body },
				flag
			}
		};
	}
};
const wikiSource = {
	id: "wiki-source-not-found",
	alias: "CD007",
	kind: "wiki-source",
	severity: "error",
	description: "Check declared raw source files in a wiki whose configuration documents the raw source convention.",
	guidance: "Check the wiki's provenance and restore or correct the source reference.",
	async check(reference, { file, tree, skip }) {
		if (!reference.value.startsWith("raw/") || reference.value.includes("\0")) return skip("wiki-source-outside-raw-convention");
		for (const directory of tree.ancestors(file)) {
			if (displayPath(tree.root, directory).split("/").at(-1) !== "wiki") continue;
			const config = resolve(directory, "config.md");
			const contents = await tree.read(config);
			if (!contents || !/\bsources\b`?[^\r\n]*\bunder[ \t]+`?raw\//i.test(contents)) return skip("wiki-convention-unavailable", config);
			const raw = resolve(directory, "raw");
			const target = resolve(directory, reference.value);
			if (!within(raw, target) || target === raw) return skip("wiki-source-outside-raw-convention");
			const entry = await tree.locate(target);
			if (entry?.kind === "file") return null;
			if (entry?.kind === "other") return skip("wiki-source-target-unavailable", target);
			const path = displayPath(tree.root, target);
			const convention = displayPath(tree.root, config);
			return {
				paths: [path, convention],
				evidence: {
					reference: reference.value,
					resolvedPath: path,
					convention
				}
			};
		}
		return skip("wiki-directory-unavailable");
	}
};
const nodeMinimum = {
	id: "node-minimum-incompatible",
	alias: "CD009",
	kind: "node-minimum",
	severity: "warning",
	description: "Check a documented Node.js minimum against the engines of locked direct dependencies.",
	guidance: "Verify the minimum Node.js version supported by this package and update the guidance.",
	async check(reference, { file, tree, markdown, packageCandidates, skip }) {
		const label = reference.packageLabel ?? "";
		const generic = /^(?:this (?:project|package|repository|repo|workspace)|(?:the )?(?:project|package|repository|repo|workspace))$/i.test(label);
		const named = generic ? [] : await packageCandidates(label);
		if (named.length > 1) return skip("manifest-ambiguous");
		let manifest = named.length === 1 ? await tree.manifestAt(dirname(resolve(tree.root, named[0]))) : null;
		if (generic) {
			manifest = await tree.manifest(file);
			if (!manifest) {
				const commands = (await markdown(file))?.references ?? [];
				const prefixes = new Set(commands.filter((command) => command.kind === "script").map((command) => command.npmPrefix));
				if (prefixes.size === 1 && !prefixes.has(void 0)) {
					const { manifests } = await scriptManifests(tree, file, { npmPrefix: [...prefixes][0] });
					if (manifests.length === 1) manifest = manifests[0];
				}
			}
		}
		if (!manifest?.data) return skip(manifest?.issue ? "manifest-" + manifest.issue : "manifest-missing", manifest?.path);
		const minimum = minVersion(reference.value);
		if (!minimum) return skip("invalid-node-minimum");
		const lock = resolve(dirname(manifest.path), "package-lock.json");
		const contents = await tree.read(lock);
		if (contents === null) return skip("npm-lockfile-unavailable", lock);
		let entries;
		try {
			const parsed = JSON.parse(contents);
			if (!isRecord(parsed) || !isRecord(parsed.packages) || !isRecord(parsed.packages[""])) return skip("npm-lockfile-invalid-shape", lock);
			entries = parsed.packages;
		} catch {
			return skip("npm-lockfile-invalid-json", lock);
		}
		const root = entries[""];
		const incompatible = [];
		let inspected = 0;
		let incomplete = false;
		for (const section of ["dependencies", "devDependencies"]) for (const [name, wanted] of Object.entries(manifest.data[section] ?? {})) {
			if (Object.hasOwn(manifest.data.optionalDependencies ?? {}, name)) continue;
			if (root[section]?.[name] !== wanted) {
				incomplete = true;
				continue;
			}
			const key = "node_modules/" + name;
			const entry = entries[key];
			const engine = entry?.engines?.node;
			if (entry?.optional) continue;
			if (!isRecord(entry) || engine !== void 0 && (typeof engine !== "string" || !validRange(engine))) {
				incomplete = true;
				continue;
			}
			if (typeof engine !== "string") continue;
			inspected++;
			if (satisfies(minimum, engine)) continue;
			incompatible.push({
				name,
				version: entry.version,
				engine,
				lockEntry: key
			});
		}
		if (incomplete) skip("npm-lockfile-incomplete-direct-dependencies", lock);
		if (!inspected) return skip("no-locked-direct-engine-constraints", lock);
		if (!incompatible.length) return null;
		const lockfile = displayPath(tree.root, lock);
		const manifestPath = displayPath(tree.root, manifest.path);
		return {
			confidence: "medium",
			paths: [lockfile, manifestPath],
			evidence: {
				documentedMinimum: minimum.version,
				manifest: manifestPath,
				lockfile,
				incompatible: incompatible.sort((a, b) => a.name.localeCompare(b.name, "en")).slice(0, 10),
				incompatibleCount: incompatible.length
			}
		};
	}
};
const packageManagerVersion = {
	id: "package-manager-version-mismatch",
	alias: "CD012",
	severity: "warning",
	description: "Compare an exact documented package-manager version with the manifest pin.",
	guidance: "Confirm the intended version and align the setup guidance with the package manifest."
};
const managerLocks = [
	{
		manager: "npm",
		files: ["package-lock.json", "npm-shrinkwrap.json"]
	},
	{
		manager: "pnpm",
		files: ["pnpm-lock.yaml"]
	},
	{
		manager: "yarn",
		files: ["yarn.lock"]
	},
	{
		manager: "bun",
		files: ["bun.lock", "bun.lockb"]
	}
];
const rules = [
	link,
	path,
	script,
	workspaceScript,
	dependency,
	runtime,
	wikiSource,
	scriptClaim,
	nodeMinimum,
	{
		id: "package-manager-mismatch",
		alias: "CD011",
		kind: "package-manager",
		severity: "warning",
		description: "Check an explicit package-manager requirement against the package manifest or lockfile.",
		guidance: "Check which workflow the declaration applies to and reconcile it with the package configuration.",
		async check(reference, { file, tree, markdown, containsLockfile, skip }) {
			if ((await markdown(file))?.historical) return skip("historical-package-manager-claim");
			const manifest = await tree.manifest(file);
			if (!manifest?.data) return skip(manifest?.issue ? "manifest-" + manifest.issue : "manifest-missing", manifest?.path);
			const manifestPath = displayPath(tree.root, manifest.path);
			const documentedVersion = reference.version ? valid(reference.version) ?? void 0 : void 0;
			const evidence = {
				documentedManager: reference.value,
				documentedVersion,
				manifest: manifestPath
			};
			const pin = manifest.data.packageManager;
			if (pin !== void 0) {
				const parsed = typeof pin === "string" ? /^(npm|pnpm|yarn|bun)@(.+)$/.exec(pin) : null;
				if (!parsed) return skip("package-manager-pin-unsupported", manifest.path);
				const [, configuredManager, descriptor] = parsed;
				const configuredVersion = valid(descriptor) ?? void 0;
				const configured = {
					...evidence,
					configuredManager,
					configuredVersion,
					manifestPointer: "/packageManager"
				};
				const paths = [manifestPath];
				if (configuredManager !== reference.value) return {
					paths,
					evidence: configured
				};
				if (!reference.version) return null;
				if (!documentedVersion || !configuredVersion) return skip("package-manager-version-unavailable", manifest.path);
				return documentedVersion === configuredVersion ? null : {
					paths,
					evidence: configured,
					diagnostic: packageManagerVersion
				};
			}
			const { devEngines } = manifest.data;
			if (isRecord(devEngines) && Object.hasOwn(devEngines, "packageManager")) return skip("dev-engines-package-manager-unsupported", manifest.path);
			const locks = [];
			for (const { manager, files } of managerLocks) for (const file of files) {
				const path = displayPath(tree.root, resolve(dirname(manifest.path), file));
				if (await containsLockfile(path)) locks.push({
					manager,
					path
				});
			}
			if (!locks.length) return skip("package-manager-evidence-missing", manifest.path);
			const configuredManager = locks[0].manager;
			if (locks.some(({ manager }) => manager !== configuredManager)) return skip("package-manager-lockfiles-ambiguous", manifest.path);
			if (configuredManager === reference.value) return reference.version ? skip("package-manager-version-unavailable", manifest.path) : null;
			const lockfiles = locks.map(({ path }) => path);
			return {
				confidence: "medium",
				paths: [manifestPath, ...lockfiles],
				evidence: {
					...evidence,
					configuredManager,
					lockfiles
				}
			};
		}
	}
];
const ruleCatalog = [
	...rules,
	unknownScriptScope,
	unresolvedShorthand,
	packageManagerVersion
];
// src/analysis/scan.ts
function compare(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
async function indexEntries(file, root, document, markdown) {
	const indexes = /* @__PURE__ */ new Map();
	for (const reference of document.references) {
		if (reference.kind !== "link" && reference.kind !== "path") continue;
		const target = localTarget(file, root, reference.value, reference.kind === "link");
		if (!target || !/^(?:readme|index)\.md$/i.test(basename(target.path))) continue;
		const paths = [target.path];
		if (reference.kind === "path" && !/^\.{1,2}\//.test(reference.value)) paths.push(resolve(root, reference.value));
		for (const path of paths) if (path !== file && !indexes.has(path)) indexes.set(path, {
			line: reference.line,
			column: reference.column
		});
	}
	const entries = /* @__PURE__ */ new Map();
	for (const [index, position] of indexes) {
		const content = await markdown(index);
		const added = /* @__PURE__ */ new Set();
		for (const reference of content?.references ?? []) {
			if (reference.kind !== "link") continue;
			const target = localTarget(index, root, reference.value, true);
			if (!target || dirname(target.path) !== dirname(index) || target.path === index) continue;
			const name = basename(target.path);
			if (!isMarkdown(name) || added.has(name)) continue;
			added.add(name);
			const matches = entries.get(name) ?? [];
			matches.push({
				path: target.path,
				index,
				...position
			});
			entries.set(name, matches);
		}
	}
	return entries;
}
async function scan(repository, changed, options = {}) {
	const { root, scope } = repository;
	const tree = new WorkingTree(root);
	const resolveWorkspace = workspaceResolver(tree, () => packageManifestPaths(repository));
	const parsed = /* @__PURE__ */ new Map();
	const markdown = (file) => {
		let result = parsed.get(file);
		if (!result) {
			result = tree.read(file).then((contents) => contents === null ? null : parseMarkdown(contents, options.inventory));
			parsed.set(file, result);
		}
		return result;
	};
	let tracked;
	let trackedEvidence;
	const containsLockfile = async (path) => {
		if ((await tree.locate(resolve(root, path)))?.kind !== "file") return false;
		if (!repository.isGit) return true;
		tracked ??= trackedPaths(repository);
		trackedEvidence ??= new Set(await tracked);
		return trackedEvidence.has(path);
	};
	const ignored = /* @__PURE__ */ new Map();
	const ignoredAtRoot = (path) => {
		let result = ignored.get(path);
		if (!result) {
			result = isIgnored(repository, path);
			ignored.set(path, result);
		}
		return result;
	};
	const packageCandidates = async (name) => {
		const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
		const label = normalize(name);
		if (!label) return [];
		tracked ??= trackedPaths(repository);
		const matches = [];
		for (const path of await tracked) {
			if (!path.endsWith("/package.json") || normalize(posix.basename(posix.dirname(path))) !== label) continue;
			if ((await tree.locate(resolve(root, path)))?.kind === "file") matches.push(path);
			if (matches.length === 5) break;
		}
		return matches;
	};
	const pathCandidates = async (reference, directory, under) => {
		tracked ??= trackedPaths(repository);
		const matches = [];
		for (const path of await tracked) {
			if (under && !path.startsWith(under + "/") || !path.endsWith("/" + reference)) continue;
			const entry = await tree.locate(resolve(root, path));
			if (entry && (directory ? entry.kind === "directory" : entry.kind !== "other")) matches.push(path);
			if (matches.length === 5) break;
		}
		return matches;
	};
	const discovery = await discover(repository, options);
	const queue = new Set(discovery.selected.keys());
	const inventory = /* @__PURE__ */ new Map();
	const addDocument = (file, via, depth) => {
		const path = displayPath(root, file);
		const document = {
			path,
			directory: posix.dirname(path),
			format: posix.extname(path).slice(1) || "extensionless",
			convention: contextConvention(path),
			via,
			depth,
			status: via === "observed-convention" ? "observed-only" : "unavailable",
			links: {
				total: 0,
				examples: []
			},
			checks: {},
			limitations: {}
		};
		if (via === "observed-convention") note(document, { reason: options.includeObserved && !isMarkdown(file) ? "unsupported-context-format" : "convention-observed-only" });
		inventory.set(file, document);
		return document;
	};
	if (options.inventory) {
		for (const file of discovery.other) addDocument(file, "observed-convention", null);
		for (const [file, source] of discovery.selected) addDocument(file, source, 0);
	}
	const findings = [];
	const repeatedPaths = /* @__PURE__ */ new Map();
	const changedAncestors = new Set(changed);
	for (const path of changed ?? []) for (let directory = posix.dirname(path); directory !== "."; directory = posix.dirname(directory)) changedAncestors.add(directory);
	let documents = 0;
	for (const file of queue) {
		const record = inventory.get(file);
		let document;
		try {
			if (discovery.selected.get(file) === "included-convention") {
				const location = await tree.locate(file);
				if (location?.kind === "file" && (!within(scope, location.path) || !isMarkdown(location.path))) {
					if (record) note(record, { reason: "included-file-target-outside-scope-or-format" });
					continue;
				}
			}
			document = await markdown(file);
		} catch (error) {
			if (!record || !["EACCES", "EPERM"].includes(error.code ?? "")) throw error;
			note(record, { reason: "document-unreadable" });
			continue;
		}
		if (!document) {
			if (record) note(record, { reason: "document-unavailable" });
			continue;
		}
		const successful = /* @__PURE__ */ new Map();
		const duplicateChecks = /* @__PURE__ */ new Set();
		let indexed;
		const indexedPath = async (name, line, column) => {
			indexed ??= indexEntries(file, root, document, markdown);
			const matches = (await indexed).get(name)?.filter((entry) => entry.line < line || entry.line === line && entry.column < column);
			return matches?.length === 1 ? matches[0] : void 0;
		};
		if (record) {
			record.status = "analysed";
			record.measurements = document.measurements;
			for (const notice of document.notices) note(record, notice);
		}
		documents++;
		const source = displayPath(root, file);
		for (const reference of document.references) {
			if (reference.kind === "link") {
				const target = localTarget(file, root, reference.value, true);
				if (target) {
					const inScope = within(scope, target.path);
					const markdownTarget = isMarkdown(target.path);
					if (record) {
						record.links.total++;
						if (record.links.examples.length < 20) record.links.examples.push({
							line: reference.line,
							target: displayPath(root, target.path),
							inScope,
							markdown: markdownTarget
						});
					}
					if (inScope && markdownTarget && !queue.has(target.path)) {
						queue.add(target.path);
						if (record) addDocument(target.path, "local-link", (record.depth ?? 0) + 1);
					}
				}
			}
			const rule = rules.find(({ kind }) => kind === reference.kind);
			if (!rule) continue;
			let skipped = false;
			const skip = (reason, path) => {
				skipped = true;
				if (record) note(record, {
					reason,
					line: reference.line,
					...path ? { path: displayPath(root, path) } : {}
				});
				return null;
			};
			const result = await rule.check(reference, {
				file,
				tree,
				markdown,
				pathCandidates,
				packageCandidates,
				containsLockfile,
				resolveWorkspace,
				indexedPath,
				isIgnored: ignoredAtRoot,
				inventory: Boolean(record),
				skip
			}).catch((error) => {
				if (!record || !["EACCES", "EPERM"].includes(error.code ?? "")) throw error;
				return skip("reference-evidence-unreadable");
			});
			const checkKey = options.snapshot ? referenceKey(reference) : void 0;
			if (record) {
				const coverage = record.checks[reference.kind] ?? {
					examined: 0,
					skipped: 0,
					findings: 0
				};
				if (skipped) coverage.skipped++;
				else coverage.examined++;
				if (result) coverage.findings++;
				record.checks[reference.kind] = coverage;
				if (checkKey) {
					if (successful.has(checkKey)) duplicateChecks.add(checkKey);
					successful.set(checkKey, !duplicateChecks.has(checkKey) && !skipped && !result);
				}
			}
			if (!result) continue;
			if (changed && !changed.has(source) && !result.paths.some((path) => changedAncestors.has(path))) continue;
			const diagnostic = result.diagnostic ?? rule;
			let context;
			let reason;
			if (diagnostic.id === "script-scope-unknown") {
				if (reference.npmPrefix !== void 0) {
					context = "prefix:" + reference.npmPrefix;
					reason = "Shared npm prefix " + reference.npmPrefix;
				} else if (reference.workingDirectory !== void 0) {
					context = "directory:" + reference.workingDirectory;
					reason = "Shared working directory " + reference.workingDirectory;
				} else if (reference.packageRow?.label) {
					context = "row:" + reference.packageRow.line;
					reason = "Shared package row for " + reference.packageRow.label;
				}
			} else if (diagnostic.id === "reference-not-found") {
				if (document.historical) {
					context = "snapshot";
					reason = document.historical.revision ? "Immutable snapshot at " + document.historical.revision : "Immutable snapshot";
				} else if (typeof result.evidence.documentIndex === "string") {
					context = "document-index:" + result.evidence.documentIndex;
					reason = "Shared documentation index " + result.evidence.documentIndex;
				} else if (result.candidates?.length === 1) {
					const suffix = reference.value.replace(/\/$/, "");
					const prefix = result.candidates[0].slice(0, -suffix.length - 1);
					context = "path-prefix:" + prefix;
					reason = "Tracked paths share prefix " + prefix;
				}
			}
			const reviewGroup = context && reason ? {
				id: createHash("sha256").update(JSON.stringify([source, context])).digest("hex").slice(0, 16),
				reason
			} : void 0;
			const finding = {
				rule: diagnostic.id,
				severity: diagnostic.severity,
				confidence: result.confidence ?? "high",
				source: {
					file: source,
					line: reference.line,
					column: reference.column
				},
				evidence: result.evidence,
				...reviewGroup ? { reviewGroup } : {},
				...result.candidates?.length ? { candidates: result.candidates } : {},
				guidance: diagnostic.guidance,
				...checkKey ? { checkKey } : {}
			};
			findings.push(finding);
			if (diagnostic.id === "reference-not-found" && !reviewGroup) {
				const key = JSON.stringify([source, "path-reference:" + reference.value]);
				const occurrences = repeatedPaths.get(key) ?? [];
				occurrences.push(finding);
				repeatedPaths.set(key, occurrences);
			}
		}
		if (record && options.snapshot) {
			record.successfulChecks = [...successful].filter(([, passed]) => passed).map(([key]) => key).sort();
			record.duplicateChecks = [...duplicateChecks].sort();
		}
	}
	for (const [key, occurrences] of repeatedPaths) {
		if (occurrences.length < 2) continue;
		const reviewGroup = {
			id: createHash("sha256").update(key).digest("hex").slice(0, 16),
			reason: "Repeated reference to " + String(occurrences[0].evidence.reference)
		};
		for (const finding of occurrences) finding.reviewGroup = reviewGroup;
	}
	findings.sort((a, b) => compare(a.severity, b.severity) || compare(a.source.file, b.source.file) || a.source.line - b.source.line || a.source.column - b.source.column || compare(a.rule, b.rule));
	return {
		documents,
		findings,
		selection: discovery.selection,
		inventory: [...inventory.values()].sort((a, b) => compare(a.path, b.path))
	};
}
// src/reporters/index.ts
function printable(value) {
	return stripVTControlCharacters(String(value)).replace(/[\n\r\t]/g, " ");
}
function observation({ rule, evidence }) {
	switch (rule) {
		case "broken-markdown-link": return evidence.anchorExists === false ? "Heading anchor #" + printable(evidence.fragment) + " is missing in " + printable(evidence.resolvedPath) : "Link destination is missing: " + printable(evidence.resolvedPath);
		case "wiki-source-not-found": return "Wiki source is missing: " + printable(evidence.resolvedPath);
		case "reference-not-found": return evidence.exists === true ? "Expected a " + printable(evidence.expectedKind ?? "directory") + " at " + printable(evidence.resolvedPath) : "Referenced path is missing: " + printable(evidence.resolvedPath);
		case "script-scope-unknown": return "Could not establish the package for script " + printable(evidence.script);
		case "workspace-target-unresolved": return evidence.workspaceMatchCount === 0 ? "Workspace " + printable(evidence.workspace) + " was not found under " + printable(evidence.workspaceDefinition) : "Workspace " + printable(evidence.workspace) + " matches multiple manifests under " + printable(evidence.workspaceDefinition);
		case "script-mutates-files": return "Script " + printable(evidence.script) + " uses " + printable(evidence.flag) + " in " + printable(evidence.manifest);
		case "script-not-defined":
		case "script-shorthand-unresolved": return "Script " + printable(evidence.script) + (evidence.manifest ? " is missing from " + printable(evidence.manifest) : " has no package.json in scope");
		case "dependency-not-declared": return "Package " + printable(evidence.package) + " is undeclared in " + printable(evidence.manifest);
		case "package-manager-mismatch": return "Documented package manager " + printable(evidence.documentedManager) + " differs from " + printable(evidence.configuredManager) + " in " + (Array.isArray(evidence.lockfiles) ? evidence.lockfiles.map(printable).join(", ") : printable(evidence.manifest));
		case "package-manager-version-mismatch": return "Documented " + printable(evidence.documentedManager) + " " + printable(evidence.documentedVersion) + " differs from " + printable(evidence.configuredVersion) + " in " + printable(evidence.manifest);
		case "node-minimum-incompatible": return "Documented Node.js minimum " + printable(evidence.documentedMinimum) + " conflicts with locked dependencies in " + printable(evidence.lockfile);
		case "node-version-mismatch": return "Documented Node.js " + printable(evidence.documentedVersion) + " is incompatible with " + evidence.incompatible.map(({ file, version }) => printable(file) + " (" + printable(version) + ")").join(", ");
		default: return rule;
	}
}
function formatText(report) {
	const { scope, summary, page, findings } = report;
	const lines = ["Context Doctor · " + printable(scope.path) + (scope.changed ? " · changed paths" : ""), ""];
	const groupSizes = /* @__PURE__ */ new Map();
	for (const { reviewGroup } of findings) if (reviewGroup) groupSizes.set(reviewGroup.id, (groupSizes.get(reviewGroup.id) ?? 0) + 1);
	const shownGroups = /* @__PURE__ */ new Set();
	for (const finding of findings) {
		const group = finding.reviewGroup;
		if (group && !shownGroups.has(group.id)) {
			const size = groupSizes.get(group.id) ?? 0;
			if (size > 1) lines.push(printable(group.reason) + " · " + size + " findings on this page");
			shownGroups.add(group.id);
		}
		const { source, severity, confidence, rule } = finding;
		const location = printable(source.file) + ":" + source.line + ":" + source.column;
		const label = styleText(severity === "error" ? "red" : "yellow", severity);
		lines.push(location + "  " + label + "  " + observation(finding));
		lines.push("  " + rule + " · " + confidence + " confidence");
		if (finding.candidates) lines.push("  Tracked path candidates " + finding.candidates.map(printable).join(", "));
	}
	if (findings.length) lines.push("");
	lines.push(summary.documents + " documents scanned · " + summary.errors + " errors · " + summary.warnings + " warnings");
	if (!summary.documents) lines.push("No guidance was examined. Use --inventory to inspect coverage or --entry to add a guide.");
	if (page.nextOffset !== null) lines.push("More findings available with --offset " + page.nextOffset + ".");
	return lines.join("\n");
}
// src/cli/index.ts
const help = `Context Doctor checks coding agent instructions against the working tree.

Usage
  context-doctor scan [directory] [options]
  context-doctor compare <before.json> <after.json>
  context-doctor explain <rule> [--json]
  context-doctor --help

Scan options
  --json                 Emit the versioned JSON report
  --format <json|text>   Select the output format
  --path <path>          Scan a directory or a Markdown file
  --entry <file>         Add a repository-relative Markdown entry point (repeatable)
  --include-observed     Include recognised Markdown guidance found in inventory
  --changed              Show findings whose sources or evidence changed
  --base <ref>           Compare with this ref's merge base (requires --changed)
  --severity <level>     Minimum severity, warning or error (default warning)
  --limit <number>       Findings per report, 1–1000 (default 100)
  --inventory            Include context inventory and coverage (JSON)
  --all                  Emit every finding in one JSON report
  --offset <number>      Skip findings for pagination (default 0)

Exit codes
  0  No findings at the selected severity, or help/explain/compare succeeded
  1  Findings at the selected severity
  2  Invalid arguments or scan failure`;
function integer(value, defaultValue, name, min, max) {
	if (value === void 0) return defaultValue;
	const result = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid value for --" + name + ". Expected an integer from " + min + " to " + max + ".");
	return result;
}
async function main(args) {
	const command = args.shift();
	if (!command || command === "--help" || command === "-h" || command === "help") {
		console.log(help);
		return 0;
	}
	const outputOptions = {
		json: { type: "boolean" },
		format: { type: "string" },
		help: {
			type: "boolean",
			short: "h"
		}
	};
	const scanOptions = {
		path: { type: "string" },
		entry: {
			type: "string",
			multiple: true
		},
		"include-observed": { type: "boolean" },
		changed: { type: "boolean" },
		base: { type: "string" },
		severity: { type: "string" },
		limit: { type: "string" },
		offset: { type: "string" },
		inventory: { type: "boolean" },
		all: { type: "boolean" }
	};
	if (command !== "scan" && command !== "explain" && command !== "compare") throw new Error("Unknown command: " + command);
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			...outputOptions,
			...scanOptions
		}
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	if (values.format !== void 0 && values.format !== "text" && values.format !== "json") throw new Error("--format must be json or text");
	if (values.json && values.format === "text") throw new Error("--json conflicts with --format text");
	if (command === "compare") {
		if (Object.keys(scanOptions).some((option) => Object.hasOwn(values, option)) || values.format === "text" || positionals.length !== 2) throw new Error("Usage: context-doctor compare <before.json> <after.json>");
		console.log(JSON.stringify(await compareReports(positionals[0], positionals[1]), null, 2));
		return 0;
	}
	const json = values.json || values.format === "json" || values.inventory || values.all;
	if (command === "explain") {
		if (Object.keys(scanOptions).some((option) => Object.hasOwn(values, option))) throw new Error("Explain accepts a rule identifier and output options");
		if (positionals.length !== 1) throw new Error("Usage: context-doctor explain <rule>");
		const rule = ruleCatalog.find(({ id, alias }) => id === positionals[0] || alias === positionals[0].toUpperCase());
		if (!rule) throw new Error("Unknown rule: " + positionals[0]);
		const { id, alias, severity, description, guidance } = rule;
		console.log(json ? JSON.stringify({
			schemaVersion: 1,
			rule: id,
			alias,
			severity,
			description,
			guidance
		}, null, 2) : [
			id + " (" + alias + ") · " + severity,
			description,
			guidance
		].join("\n"));
		return 0;
	}
	if (positionals.length > 1 || positionals.length && values.path !== void 0) throw new Error("Supply one scan path using --path or a positional argument");
	if (values.severity !== void 0 && values.severity !== "warning" && values.severity !== "error") throw new Error("--severity must be warning or error");
	if (values.base !== void 0 && !values.changed) throw new Error("--base requires --changed");
	if ((values.inventory || values.all) && values.format === "text") throw new Error("--inventory and --all require JSON output");
	if (values.all && (values.limit !== void 0 || values.offset !== void 0)) throw new Error("--all cannot be combined with --limit or --offset");
	const limit = values.all ? null : integer(values.limit, 100, "limit", 1, 1e3);
	const offset = integer(values.offset, 0, "offset", 0, Number.MAX_SAFE_INTEGER);
	const repository = await openRepository(process.cwd(), values.path ?? positionals[0]);
	const changed = values.changed ? await changes(repository, values.base) : null;
	const { documents, findings, inventory, selection } = await scan(repository, changed?.paths, {
		inventory: values.inventory,
		snapshot: values.inventory && values.all,
		entries: values.entry,
		includeObserved: values["include-observed"]
	});
	const filtered = values.severity === "error" ? findings.filter(({ severity }) => severity === "error") : findings;
	const errors = filtered.filter(({ severity }) => severity === "error").length;
	const report = {
		schemaVersion: 1,
		scope: {
			path: displayPath(repository.root, repository.scope),
			changed: Boolean(changed),
			base: changed?.base ?? null,
			...selection ? { selection } : {}
		},
		summary: {
			documents,
			errors,
			warnings: filtered.length - errors,
			total: filtered.length
		},
		page: {
			offset,
			limit,
			nextOffset: limit !== null && offset + limit < filtered.length ? offset + limit : null
		},
		findings: limit === null ? filtered : filtered.slice(offset, offset + limit)
	};
	if (values.inventory) report.inventory = {
		checkoutId: digest(repository.root),
		discovery: repository.isGit ? "git-index-and-unignored" : "filesystem-walk",
		...values.all ? { snapshotVersion: 1 } : {},
		minimumSeverity: values.severity === "error" ? "error" : "warning",
		documents: inventory,
		totals: {
			bytes: inventory.reduce((total, row) => total + (row.measurements?.bytes ?? 0), 0),
			lines: inventory.reduce((total, row) => total + (row.measurements?.lines ?? 0), 0),
			analysed: documents,
			observedOnly: inventory.filter((row) => row.status === "observed-only").length,
			unavailable: inventory.filter((row) => row.status === "unavailable").length,
			maxLinkDepth: inventory.reduce((depth, row) => row.status === "analysed" ? Math.max(depth, row.depth ?? 0) : depth, 0)
		}
	};
	console.log(json ? JSON.stringify(report, null, 2) : formatText(report));
	return filtered.length ? 1 : 0;
}
try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error("Context Doctor: " + message);
	process.exitCode = 2;
}
export {};
