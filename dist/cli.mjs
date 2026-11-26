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
import { LineCounter, isScalar, isSeq, parseDocument } from "yaml";
import { gfm } from "micromark-extension-gfm";
import { intersects, minVersion, satisfies, validRange } from "semver";
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
async function findOnDisk(path, includeOther) {
	if (!(await stat(path)).isDirectory()) return [path];
	const matches = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (skipped.has(entry.name)) continue;
		const child = resolve(path, entry.name);
		if (entry.isDirectory()) matches.push(...await findOnDisk(child, includeOther));
		else if (entry.isFile() && (instructionNames.includes(entry.name) || includeOther && contextConvention(child.split(sep).join("/")))) matches.push(child);
	}
	return matches;
}
async function discover(repository, includeOther = false) {
	const { root, scope, isGit } = repository;
	if ((await stat(scope)).isFile()) {
		if (!/\.md(?:own|arkdown)?$/i.test(scope)) throw new Error("--path must be a directory or Markdown file");
		return {
			selected: [scope],
			other: []
		};
	}
	const paths = !isGit ? (await findOnDisk(scope, includeOther)).sort() : [...new Set((await git(root, [
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		...instructionNames.map((name) => ":(glob)**/" + name),
		...includeOther ? additionalPatterns.map((pattern) => ":(glob)" + pattern) : []
	])).split("\0").filter(Boolean).map((path) => resolve(root, path)))].filter((path) => within(scope, path)).sort();
	return {
		selected: paths.filter((path) => instructionNames.includes(posix.basename(displayPath(root, path)))),
		other: paths.filter((path) => !instructionNames.includes(posix.basename(displayPath(root, path))))
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
			const value = JSON.parse(contents);
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
function isMarkdown(path) {
	return /\.md(?:own|arkdown)?$/i.test(path);
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
	if (!isRecord(report) || report.schemaVersion !== 1 || !isRecord(report.scope) || typeof report.scope.path !== "string" || report.scope.changed !== false || !isRecord(report.page) || report.page.offset !== 0 || report.page.limit !== null || report.page.nextOffset !== null || !isRecord(report.summary) || !Array.isArray(report.findings) || report.summary.total !== report.findings.length || !isRecord(report.inventory) || report.inventory.snapshotVersion !== 1 || report.inventory.minimumSeverity !== "warning" || typeof report.inventory.checkoutId !== "string" || !Array.isArray(report.inventory.documents)) throw new Error(snapshotError);
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
	return digest(JSON.stringify([
		reference.kind,
		reference.value,
		reference.npmPrefix,
		reference.claim,
		reference.packageLabel,
		reference.packageRow?.label
	]));
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
const otherManager = /^(?:\$\s+)?(?:pnpm|yarn|bun|vp)\s+run\s+([a-z0-9_][\w:.-]*)(?=$|\s|[;&|])/i;
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
function scriptCommand(command) {
	const other = otherManager.exec(command);
	if (other) return { name: other[1] };
	if (!/^(?:\$\s+)?npm(?=\s)/.test(command)) return null;
	const tokens = words(command)?.slice(1);
	if (!tokens) return null;
	let name;
	let npmPrefix;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--") break;
		if (/^(?:-w|--workspaces?|--include-workspace-root|-g|--global)(?:=|$)/.test(token)) return null;
		if (token === "--prefix" || token.startsWith("--prefix=")) {
			if (npmPrefix !== void 0) return null;
			npmPrefix = token === "--prefix" ? tokens[++index] : token.slice(9);
			if (!npmPrefix || !/^[\p{L}\p{N}_. /-]+$/u.test(npmPrefix) || npmPrefix.startsWith("-")) return null;
		} else if (name === void 0) {
			if (token === "run" || token === "run-script") name = tokens[++index];
			else if (token === "test") name = token;
			else return null;
			if (!name || !scriptName.test(name)) return null;
		}
	}
	return name ? {
		name,
		...npmPrefix === void 0 ? {} : { npmPrefix }
	} : null;
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
		const addScript = (value, line, column) => {
			const command = scriptCommand(value);
			if (!command) {
				if (inventory && /^(?:\$[ \t]+)?(?:npm|pnpm|yarn|bun|vp)[ \t]+/.test(value)) notices.push({
					reason: "package-command-outside-script-parser",
					line
				});
				return false;
			}
			const packageRow = row?.type === "tableRow" && row.position ? {
				line: row.position.start.line,
				label: headingText(row.children[0]).trim()
			} : void 0;
			references.push({
				kind: "script",
				packageRow,
				value: command.name,
				npmPrefix: command.npmPrefix,
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
		if (node.type === "code" && shell.test(node.lang ?? "") && !/\bexample\b/i.test(node.meta ?? "")) node.value.split("\n").forEach((line, index) => {
			addScript(line.trimStart(), start.line + index + 1, line.length - line.trimStart().length + 1);
		});
		if (node.type === "inlineCode") {
			const prefix = previous?.type === "text" ? previous.value : "";
			const suffix = next?.type === "text" ? next.value : "";
			const claim = /^\s+is\s+(non-mutating|read-only)\b/i.exec(suffix)?.[1];
			const command = scriptCommand(node.value);
			if (claim && (command || /^[a-z0-9_][\w:.-]*$/i.test(node.value))) references.push({
				kind: "script-claim",
				value: command?.name ?? node.value,
				npmPrefix: command?.npmPrefix,
				claim,
				line: start.line,
				column: start.column
			});
			if (addScript(node.value, start.line, start.column)) return;
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
			reference.npmPrefix
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
	async check(reference, { file, tree, pathCandidates, packageCandidates, isIgnored, skip }) {
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
async function scriptManifests(tree, file, prefix) {
	const directories = prefix === void 0 ? [...tree.ancestors(file)] : [.../* @__PURE__ */ new Set([resolve(tree.root, prefix), resolve(dirname(file), prefix)])].filter((path) => within(tree.root, path));
	return {
		manifests: (prefix === void 0 ? [await tree.manifest(file)] : await Promise.all(directories.map((path) => tree.manifestAt(path)))).filter((manifest) => manifest !== null),
		paths: directories.map((path) => displayPath(tree.root, resolve(path, "package.json")))
	};
}
const unknownScriptScope = {
	id: "script-scope-unknown",
	alias: "CD006",
	severity: "warning",
	description: "Identify script commands whose owning package could not be established.",
	guidance: "Identify the intended working directory or add an explicit npm prefix before validating this script."
};
const script = {
	id: "script-not-defined",
	alias: "CD003",
	kind: "script",
	severity: "error",
	description: "Check script commands against the package selected by an explicit npm prefix or the nearest package.json.",
	guidance: "Inspect the package and instructions to confirm which script or working directory the author intended.",
	async check(reference, { file, tree, packageCandidates, skip, inventory }) {
		const prefix = reference.npmPrefix;
		const { manifests, paths } = await scriptManifests(tree, file, prefix);
		if (!paths.length) return skip("script-prefix-outside-repository");
		const evidence = {
			script: reference.value,
			...prefix === void 0 ? {} : { npmPrefix: prefix },
			...inventory ? {
				manifestStrategy: prefix === void 0 ? "nearest-ancestor" : "literal-prefix",
				searchedManifests: paths
			} : {}
		};
		if (manifests.length !== 1 || !manifests[0].data) {
			const invalid = manifests.find((manifest) => manifest.issue);
			skip(invalid?.issue ? "manifest-" + invalid.issue : manifests.length ? "manifest-ambiguous" : "manifest-missing", invalid?.path);
			return {
				paths,
				confidence: "medium",
				diagnostic: unknownScriptScope,
				evidence: {
					...evidence,
					manifest: null,
					checkedManifests: paths,
					candidateManifests: manifests.length ? manifests.map(({ path }) => displayPath(tree.root, path)) : prefix === void 0 && reference.packageRow ? await packageCandidates(reference.packageRow.label) : []
				}
			};
		}
		const [manifest] = manifests;
		const scripts = Object.keys(manifest.data?.scripts ?? {}).sort();
		if (scripts.includes(reference.value)) return null;
		const manifestPath = displayPath(tree.root, manifest.path);
		return {
			paths: [manifestPath],
			evidence: {
				...evidence,
				manifest: manifestPath,
				defined: false,
				availableScripts: scripts.slice(0, 15),
				availableScriptCount: scripts.length
			}
		};
	}
};
const dependencySections = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies"
];
const rules = [
	link,
	path,
	script,
	{
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
	},
	{
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
	},
	{
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
	},
	{
		id: "script-mutates-files",
		alias: "CD008",
		kind: "script-claim",
		severity: "error",
		description: "Check explicit read-only or non-mutating claims against supported linter commands.",
		guidance: "Confirm the intended behavior, then correct the script or the read-only claim.",
		async check(reference, { file, tree, markdown, skip, inventory }) {
			const related = ((await markdown(file))?.references ?? []).filter((command) => command.kind === "script" && command.value === reference.value && command.npmPrefix !== void 0);
			const prefixes = reference.npmPrefix !== void 0 ? [reference.npmPrefix] : related.length ? [...new Set(related.map((command) => command.npmPrefix))] : [void 0];
			const manifests = /* @__PURE__ */ new Map();
			for (const prefix of prefixes) {
				const { manifests: choices } = await scriptManifests(tree, file, prefix);
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
	},
	{
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
						const { manifests } = await scriptManifests(tree, file, [...prefixes][0]);
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
	}
];
const ruleCatalog = [...rules, unknownScriptScope];
// src/analysis/scan.ts
function compare(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
async function scan(repository, changed, options) {
	const { root, scope } = repository;
	const tree = new WorkingTree(root);
	const parsed = /* @__PURE__ */ new Map();
	const markdown = (file) => {
		let result = parsed.get(file);
		if (!result) {
			result = tree.read(file).then((contents) => contents === null ? null : parseMarkdown(contents, Boolean(options)));
			parsed.set(file, result);
		}
		return result;
	};
	let tracked;
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
	const discovery = await discover(repository, Boolean(options));
	const queue = new Set(discovery.selected);
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
		if (via === "observed-convention") note(document, { reason: "convention-observed-only" });
		inventory.set(file, document);
		return document;
	};
	if (options) {
		for (const file of discovery.other) addDocument(file, "observed-convention", null);
		for (const file of discovery.selected) addDocument(file, file === scope ? "explicit-file" : "default-entry", 0);
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
				isIgnored: ignoredAtRoot,
				inventory: Boolean(record),
				skip
			}).catch((error) => {
				if (!record || !["EACCES", "EPERM"].includes(error.code ?? "")) throw error;
				return skip("reference-evidence-unreadable");
			});
			const checkKey = options?.snapshot ? referenceKey(reference) : void 0;
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
				} else if (reference.packageRow?.label) {
					context = "row:" + reference.packageRow.line;
					reason = "Shared package row for " + reference.packageRow.label;
				}
			} else if (diagnostic.id === "reference-not-found") {
				if (document.historical) {
					context = "snapshot";
					reason = document.historical.revision ? "Immutable snapshot at " + document.historical.revision : "Immutable snapshot";
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
		if (record && options?.snapshot) {
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
		case "reference-not-found": return evidence.exists === true ? "Expected a directory at " + printable(evidence.resolvedPath) : "Referenced path is missing: " + printable(evidence.resolvedPath);
		case "script-scope-unknown": return "Could not establish the package for script " + printable(evidence.script);
		case "script-mutates-files": return "Script " + printable(evidence.script) + " uses " + printable(evidence.flag) + " in " + printable(evidence.manifest);
		case "script-not-defined": return "Script " + printable(evidence.script) + (evidence.manifest ? " is missing from " + printable(evidence.manifest) : " has no package.json in scope");
		case "dependency-not-declared": return "Package " + printable(evidence.package) + " is undeclared in " + printable(evidence.manifest);
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
	const { documents, findings, inventory } = await scan(repository, changed?.paths, values.inventory ? { snapshot: Boolean(values.all) } : void 0);
	const filtered = values.severity === "error" ? findings.filter(({ severity }) => severity === "error") : findings;
	const errors = filtered.filter(({ severity }) => severity === "error").length;
	const report = {
		schemaVersion: 1,
		scope: {
			path: displayPath(repository.root, repository.scope),
			changed: Boolean(changed),
			base: changed?.base ?? null
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
