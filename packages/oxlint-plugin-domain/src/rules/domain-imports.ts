import * as path from "node:path";
import { isRelative } from "../ast.ts";
import { aliasTarget, packageRoot } from "../files.ts";
import type { Node, Rule } from "../types.ts";

const ALLOWED = ["@alchemy.run/domain", "effect"];
/**
 * Type-only imports allowed by default. A port's methods may require
 * `RuntimeContext` from `alchemy` (building-blocks.md, "Projection and its
 * port"), which is erased at runtime.
 */
const ALLOWED_TYPES = ["alchemy"];

const matches = (source: string, allowed: string) =>
  source === allowed || source.startsWith(`${allowed}/`);

/**
 * A test for "the path is in this directory": a directory (absolute, or
 * relative to `cwd`), or a glob of directories relative to `cwd`, where `*`
 * is one path segment and `**` any number of them.
 */
const pathMatcher = (cwd: string, entry: string): ((target: string) => boolean) => {
  if (!entry.includes("*")) {
    const dir = path.resolve(cwd, entry);
    return (target) => {
      const relative = path.relative(dir, target);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    };
  }
  const glob = entry.replace(/\/+$/, "").replace(/\/\*\*$/, "");
  const pattern = glob
    .split("/")
    .map((part) =>
      part === "**"
        ? "(?:[^/]+/)*"
        : `${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}/`,
    )
    .join("");
  const regex = new RegExp(`^${pattern}`);
  return (target) => {
    const relative = path.relative(cwd, target).split(path.sep).join("/");
    return !relative.startsWith("..") && regex.test(`${relative}/`);
  };
};

/**
 * SKILL.md: "The domain package imports only `@alchemy.run/domain` and `effect`.
 * Cloudflare, Stripe, databases and HTTP session handling belong to the server package."
 *
 * Enable it on the domain package's source (`overrides[].files`). Relative
 * imports must stay inside the package. Type-only imports of `alchemy` are
 * allowed (a port may require `RuntimeContext`); set `allowTypes` to change that.
 * `allowPaths` lists directories (absolute, or relative to the lint's working
 * directory) a relative import may leave the package for, such as a pure
 * module shared with a package that has not moved yet.
 *
 * An import through a `compilerOptions.paths` alias of the nearest
 * `tsconfig.json` (`@/core/money`) is checked like a relative one, by where it
 * points. In an app that keeps each domain in a folder instead of a package,
 * `boundary` names that folder (`"domain"`): the nearest directory above the
 * file with that name is the domain, and an import may not leave it.
 * `forbidPaths` lists directories (or globs of directories, relative to the
 * working directory) no import may reach, such as every `server` folder of `src`, also when
 * the import stays in the package.
 */
export const domainImports: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The domain package imports only `@alchemy.run/domain`, `effect` and its own files.",
    },
    messages: {
      forbidden:
        "The domain package imports only `@alchemy.run/domain` and `effect`, not `{{source}}`. Move code that needs it to the server package, behind a port or an external system.",
      outside:
        "`{{source}}` leaves the domain package. Import other packages by name, and only `@alchemy.run/domain` and `effect`.",
      reaches:
        "`{{source}}` reaches `{{path}}`, code the domain may not import (`forbidPaths`). Give the domain what it needs through a port or an external system.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: { type: "array", items: { type: "string" } },
          allowTypes: { type: "array", items: { type: "string" } },
          allowPaths: { type: "array", items: { type: "string" } },
          boundary: { type: "string" },
          forbidPaths: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = (context.options[0] ?? {}) as {
      allow?: ReadonlyArray<string>;
      allowTypes?: ReadonlyArray<string>;
      allowPaths?: ReadonlyArray<string>;
      boundary?: string;
      forbidPaths?: ReadonlyArray<string>;
    };
    const allowed = [...ALLOWED, ...(options.allow ?? [])];
    const allowedTypes = [...allowed, ...(options.allowTypes ?? ALLOWED_TYPES)];
    const boundaryRoot = (file: string, name: string): string | undefined => {
      let dir = path.dirname(file);
      for (;;) {
        if (path.basename(dir) === name) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    };
    const root =
      options.boundary === undefined
        ? packageRoot(context.filename)
        : (boundaryRoot(context.filename, options.boundary) ?? packageRoot(context.filename));
    const inside = (dir: string, target: string) => {
      const relative = path.relative(dir, target);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    const allowedPaths = (options.allowPaths ?? []).map((entry) => pathMatcher(context.cwd, entry));
    const forbiddenPaths = (options.forbidPaths ?? []).map((entry) => ({
      entry,
      test: pathMatcher(context.cwd, entry),
    }));

    const check = (node: Node, source: unknown, typeOnly = false) => {
      if (typeof source !== "string") return;
      const target = isRelative(source)
        ? path.resolve(path.dirname(context.filename), source)
        : aliasTarget(context.filename, source);
      if (target !== undefined) {
        const forbidden = forbiddenPaths.find(({ test }) => test(target));
        if (forbidden !== undefined) {
          context.report({ node, messageId: "reaches", data: { source, path: forbidden.entry } });
          return;
        }
        if (root === undefined) return;
        if (!inside(root, target) && !allowedPaths.some((test) => test(target))) {
          context.report({ node, messageId: "outside", data: { source } });
        }
        return;
      }
      if (!(typeOnly ? allowedTypes : allowed).some((entry) => matches(source, entry))) {
        context.report({ node, messageId: "forbidden", data: { source } });
      }
    };

    return {
      ImportDeclaration: (node) =>
        check(
          node.source,
          node.source.value,
          node.importKind === "type" ||
            (node.specifiers.length > 0 &&
              node.specifiers.every((specifier: Node) => specifier.importKind === "type")),
        ),
      ExportAllDeclaration: (node) =>
        check(node.source, node.source.value, node.exportKind === "type"),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node.source, node.source.value, node.exportKind === "type");
      },
      ImportExpression: (node) => {
        if (node.source.type === "Literal") check(node.source, node.source.value);
      },
      CallExpression: (node) => {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments[0]?.type === "Literal"
        ) {
          check(node.arguments[0], node.arguments[0].value);
        }
      },
    };
  },
};
