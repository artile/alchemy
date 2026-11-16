/**
 * Cross-file lookups. An oxlint JS rule sees one file's AST, so rules that
 * need a second file (a command's `rejects`, the kind of an imported class,
 * the stories of a package) read that file's text and scan it. The scans are
 * deliberately simple: they understand the shapes the alchemy-domain skill
 * prescribes (`export class X extends Domain.Y(...)`), not every program.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { KINDS, type Kind, isRelative } from "./ast.ts";

const TTL_MS = 5_000;

interface Cached<A> {
  readonly at: number;
  readonly value: A;
}

const cached = <A>(cache: Map<string, Cached<A>>, key: string, compute: () => A): A => {
  const now = performance.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = compute();
  cache.set(key, { at: now, value });
  return value;
};

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * `file` exists under exactly this name. A case-insensitive file system
 * (macOS, Windows) answers `stat("Account.id.ts")` for `account.id.ts`, so
 * the name is compared with the directory listing.
 */
export const exists = (file: string): boolean => {
  if (!isFile(file)) return false;
  try {
    return fs.readdirSync(path.dirname(file)).includes(path.basename(file));
  } catch {
    return false;
  }
};

export const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** `x` → `x`, `x.ts`, `x.tsx`, `x/index.ts`; `x.js` → also `x.ts`. */
const fileOf = (base: string): string | undefined => {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
  return candidates.find(isFile);
};

/**
 * JSON with comments and trailing commas (a `tsconfig.json`), or `undefined`.
 * Comments are removed outside strings only, so `"@/*"` stays as it is.
 */
export const parseJsonc = (text: string): unknown => {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
};

/** One `compilerOptions.paths` entry: `"@/*": ["./src/*"]`, with absolute targets. */
interface PathAlias {
  readonly prefix: string;
  readonly suffix: string;
  readonly targets: ReadonlyArray<string>;
}

interface TsConfig {
  readonly extends?: unknown;
  readonly compilerOptions?: {
    readonly baseUrl?: string;
    readonly paths?: Readonly<Record<string, ReadonlyArray<string>>>;
  };
}

/** The `paths` of a tsconfig, following `extends` to a relative file. */
const tsconfigPaths = (file: string, depth = 0): ReadonlyArray<PathAlias> => {
  const text = readText(file);
  const json = text === undefined ? undefined : (parseJsonc(text) as TsConfig | undefined);
  if (json === undefined || depth > 5) return [];
  const options = json.compilerOptions ?? {};
  if (options.paths === undefined) {
    const parent =
      typeof json.extends === "string" && isRelative(json.extends) ? json.extends : undefined;
    if (parent === undefined) return [];
    const resolved = path.resolve(path.dirname(file), parent);
    return tsconfigPaths(resolved.endsWith(".json") ? resolved : `${resolved}.json`, depth + 1);
  }
  const base = path.resolve(path.dirname(file), options.baseUrl ?? ".");
  return Object.entries(options.paths).flatMap(([pattern, targets]) => {
    const star = pattern.indexOf("*");
    return [
      {
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? "" : pattern.slice(star + 1),
        targets: (Array.isArray(targets) ? targets : []).map((target) =>
          path.resolve(base, target),
        ),
      },
    ];
  });
};

const aliasCache = new Map<string, Cached<ReadonlyArray<PathAlias>>>();

/** The path aliases of the nearest `tsconfig.json` above `file`. */
const aliasesFor = (file: string): ReadonlyArray<PathAlias> =>
  cached(aliasCache, path.dirname(file), () => {
    let dir = path.dirname(file);
    for (;;) {
      const config = path.join(dir, "tsconfig.json");
      if (isFile(config)) return tsconfigPaths(config);
      const parent = path.dirname(dir);
      if (parent === dir) return [];
      dir = parent;
    }
  });

/**
 * Where a `compilerOptions.paths` alias points (`@/core/x` → `<root>/src/core/x`):
 * the first target that names a file, else the first target, or `undefined`
 * when no alias matches.
 */
export const aliasTarget = (importer: string, source: string): string | undefined => {
  for (const alias of aliasesFor(importer)) {
    const exact = alias.suffix === "" && !alias.prefix.endsWith("/") && alias.prefix === source;
    const matches =
      exact ||
      (source.startsWith(alias.prefix) &&
        source.endsWith(alias.suffix) &&
        source.length >= alias.prefix.length + alias.suffix.length);
    if (!matches) continue;
    const middle = exact
      ? ""
      : source.slice(alias.prefix.length, source.length - alias.suffix.length);
    const bases = alias.targets.map((target) => target.replace("*", middle));
    return bases.find((base) => fileOf(base) !== undefined) ?? bases[0];
  }
  return undefined;
};

/**
 * The file an import resolves to: a relative path, or a `compilerOptions.paths`
 * alias of the nearest `tsconfig.json`. Package imports are not followed.
 */
export const resolveImport = (importer: string, source: string): string | undefined => {
  if (isRelative(source)) return fileOf(path.resolve(path.dirname(importer), source));
  const aliased = aliasTarget(importer, source);
  return aliased === undefined ? undefined : fileOf(aliased);
};

const packageRoots = new Map<string, Cached<string | undefined>>();

/** The nearest directory above `file` with a `package.json`. */
export const packageRoot = (file: string): string | undefined =>
  cached(packageRoots, path.dirname(file), () => {
    let dir = path.dirname(file);
    for (;;) {
      if (isFile(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  });

/** What one module declares, read from its text. */
export interface ModuleIndex {
  /** Exported building blocks by name. */
  readonly kinds: ReadonlyMap<string, Kind>;
  /** A command's `rejects: [...]` names, by command name. */
  readonly rejects: ReadonlyMap<string, ReadonlyArray<string>>;
}

const DECLARATION =
  /\b(?:class\s+([A-Za-z_$][\w$]*)\s+extends|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)\s*([A-Za-z_$][\w$.]*)\s*(?:<[^()]*?>)?\s*\(/g;

const kindOfCallee = (callee: string): Kind | undefined => {
  const parts = callee.split(".");
  const last = parts.at(-1)!;
  if (KINDS.has(last)) return last as Kind;
  if (last === "make" && parts.length >= 2 && KINDS.has(parts.at(-2)!)) return parts.at(-2) as Kind;
  if (last === "Service" && parts.at(-2) === "RpcMiddleware") return "Middleware";
  return undefined;
};

/**
 * The names in a `rejects: [A, B]` list: `[]` when there is no `rejects`, and
 * `undefined` when the list is not a plain array of names (`rejects: shared`,
 * `[...shared, A]`), so a caller does not report what it cannot read.
 */
const rejectsList = (body: string): ReadonlyArray<string> | undefined => {
  if (!/\brejects\s*:/.test(body)) return [];
  const listed = /\brejects\s*:\s*\[([^\]]*)\]/.exec(body);
  if (listed === null) return undefined;
  const entries = listed[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.every((entry) => /^[A-Za-z_$][\w$]*$/.test(entry)) ? entries : undefined;
};

export const indexText = (text: string): ModuleIndex => {
  const kinds = new Map<string, Kind>();
  const rejects = new Map<string, ReadonlyArray<string>>();
  const matches = [...text.matchAll(DECLARATION)];
  matches.forEach((match, i) => {
    const name = match[1] ?? match[2]!;
    const kind = kindOfCallee(match[3]!);
    if (kind === undefined) return;
    kinds.set(name, kind);
    if (
      kind === "Command" ||
      kind === "View" ||
      kind === "Saga" ||
      kind === "Stream" ||
      kind === "Query"
    ) {
      const body = text.slice(match.index!, matches[i + 1]?.index ?? text.length);
      const listed = rejectsList(body);
      if (listed !== undefined) rejects.set(name, listed);
    }
  });
  return { kinds, rejects };
};

const indexes = new Map<string, Cached<ModuleIndex | undefined>>();

export const moduleIndex = (file: string): ModuleIndex | undefined =>
  cached(indexes, file, () => {
    const text = readText(file);
    return text === undefined ? undefined : indexText(text);
  });

const SKIP_DIRS = new Set(["node_modules", "lib", "dist", "build", "coverage", ".alchemy", ".git"]);
const STORY_FILE = /\.(?:test|spec|story|stories)\.[cm]?tsx?$/;
const STORY_IMPORT = "@alchemy.run/domain/Story";

const listFiles = (dir: string, out: Array<string>): void => {
  let entries: Array<fs.Dirent>;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile() && STORY_FILE.test(entry.name)) out.push(full);
  }
};

const SOURCE_FILE = /\.[cm]?tsx?$/;

const listSources = (dir: string, out: Array<string>): void => {
  let entries: Array<fs.Dirent>;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (
      entry.isFile() &&
      SOURCE_FILE.test(entry.name) &&
      !STORY_FILE.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
};

const sagaOrCommandRejects = new Map<string, Cached<ReadonlyMap<string, ReadonlySet<string>>>>();

/**
 * The rejections a story can assert, by the file that lists them: the
 * `rejects` of every command (`Story.rejected`) and saga (its `Rejected`
 * status) in a package's source. A view's or a read's rejections come from
 * `validate`, which only an Api test reaches.
 */
export const storyRejections = (root: string): ReadonlyMap<string, ReadonlySet<string>> =>
  cached(sagaOrCommandRejects, root, () => {
    const files: Array<string> = [];
    listSources(root, files);
    const byFile = new Map<string, ReadonlySet<string>>();
    for (const file of files) {
      const index = moduleIndex(file);
      if (index === undefined) continue;
      const names = new Set<string>();
      for (const [owner, listed] of index.rejects) {
        const kind = index.kinds.get(owner);
        if (kind === "Command" || kind === "Saga") listed.forEach((name) => names.add(name));
      }
      if (names.size > 0) byFile.set(file, names);
    }
    return byFile;
  });

const stories = new Map<string, Cached<ReadonlyArray<string>>>();

/** The text of each story file of a package (files that import `@alchemy.run/domain/Story`). */
export const storyTexts = (root: string): ReadonlyArray<string> =>
  cached(stories, root, () => {
    const files: Array<string> = [];
    listFiles(root, files);
    return files
      .map(readText)
      .filter((text): text is string => text !== undefined && text.includes(STORY_IMPORT));
  });

/** The text of every story file of a package, joined. */
export const storyText = (root: string): string => storyTexts(root).join("\n");
