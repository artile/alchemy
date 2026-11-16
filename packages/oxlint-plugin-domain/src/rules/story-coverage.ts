import {
  type Block,
  arrayIdentifiers,
  getProperty,
  memberPath,
  propertyName,
  unwrap,
} from "../ast.ts";
import { type DomainFile, domainFile } from "../file.ts";
import {
  packageRoot,
  readText,
  resolveImport,
  storyRejections,
  storyText,
  storyTexts,
} from "../files.ts";
import type { Node, Rule } from "../types.ts";

const escape = (name: string) => name.replace(/[$]/g, "\\$");

/**
 * `new X(`, `new X<...>(`, `X.make(`, or a story helper that builds it from the
 * class and its fields: `rejection(X, { ... })`.
 */
const built = (name: string) =>
  new RegExp(
    `\\bnew\\s+${escape(name)}\\s*[(<]|\\b${escape(name)}\\.make\\s*\\(|\\b[\\w$]+\\(\\s*${escape(name)}\\s*,`,
  );

/**
 * A `fail` (stubbed call) or `failed` (real call) step for `System.op`, untagged or
 * tagged: `Story.fail(Payments.refund, ...)`, `fail("r-2", Payments.refund, ...)`.
 */
const failStep = (system: string, op: string) =>
  new RegExp(
    `\\bfail(?:ed)?\\s*\\(\\s*(?:(["'\`])[^"'\`]*\\1\\s*,\\s*)?${escape(system)}\\s*\\.\\s*${escape(op)}\\b`,
  );

/**
 * A story that gives the system a test Layer whose op fails with the error:
 * the file names the system, has the op as a key or a method
 * (`syncClock: () => Effect.fail(new Refused(...))`), and builds the error.
 */
const fakeFails = (text: string, system: string, op: string, error: string) =>
  new RegExp(`\\b${escape(system)}\\b`).test(text) &&
  new RegExp(`(?:^|[\\s{,])${escape(op)}\\s*(?::|\\()`, "m").test(text) &&
  built(error).test(text);

/** `[A, B]`, `Schema.Union([A, B])` or `Schema.Union(A, B)`: the names, or `undefined`. */
const listedNames = (init: Node | undefined): Array<string> | undefined => {
  const value = unwrap(init);
  let elements: ReadonlyArray<Node | null> | undefined;
  if (value?.type === "ArrayExpression") elements = value.elements;
  else if (value?.type === "CallExpression" && memberPath(value.callee)?.at(-1) === "Union") {
    const first = unwrap(value.arguments[0]);
    elements = first?.type === "ArrayExpression" ? first.elements : value.arguments;
  }
  const names = (elements ?? []).flatMap((element) => {
    const id = unwrap(element);
    return id?.type === "Identifier" ? [id.name as string] : [];
  });
  return names.length > 0 ? names : undefined;
};

const UNION_TEXT = (name: string) =>
  new RegExp(
    `\\b(?:const|let)\\s+${escape(name)}\\s*(?::[^=]+)?=\\s*(?:Schema\\.Union\\(\\s*)?\\[?([\\w$\\s,]+?)\\]?\\s*[)\\];]`,
  );

/**
 * The errors one declared `error:` stands for: itself, or the members of a
 * list or union of errors (`const ConnectorErrors = [RetryLater, Refused]`),
 * declared in this file or in the relative module it is imported from. A
 * story covers the op when it fails it with any member.
 */
const errorMembers = (file: DomainFile, filename: string, name: string): ReadonlyArray<string> => {
  for (const statement of file.program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type === "Identifier" && declarator.id.name === name) {
        return listedNames(declarator.init) ?? [name];
      }
    }
  }
  const binding = file.imports.get(name);
  if (binding === undefined || binding.imported === "*") return [name];
  const target = resolveImport(filename, binding.source);
  const text = target === undefined ? undefined : readText(target);
  const match = text === undefined ? null : UNION_TEXT(binding.imported).exec(text);
  const names = match?.[1]
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry));
  return names !== undefined && names.length > 0 ? names : [name];
};

/** The ops of an external system that declare an `error:` by name: `[op, error]`. */
const declaredErrors = (block: Block): Array<readonly [string, string, Node]> => {
  const ops = block.definition?.properties ?? [];
  return ops.flatMap((property: Node) => {
    const op = propertyName(property);
    const error = getProperty(property.value, "error");
    const value = unwrap(error?.value);
    return op !== undefined && value?.type === "Identifier"
      ? [[op, value.name, error!] as const]
      : [];
  });
};

/**
 * SKILL.md: "Write stories for the happy path, every rejection, and every
 * policy reaction." and testing.md: "For every command, cover the happy path,
 * each rejection ... For every policy, cover the reaction, the reaction when
 * its command is rejected, and the reaction when an external call fails with
 * its declared error."
 *
 * Each block declared in a file appears in at least one story of its package
 * (a test file that imports `@alchemy.run/domain/Story`):
 *
 * - a command is sent (`new X(`), or one of its `events` is built (a command
 *   that only a policy or saga sends shows up through its events);
 * - a rejection that a command or a saga lists in `rejects` is built
 *   (`Story.rejected(new X(...))`, a saga's `Rejected` status). A rejection
 *   only a view or a read returns is skipped: its `validate` runs in Api tests;
 * - each error an external system op declares is built, and a story fails
 *   that op (`Story.fail(System.op, new X(...))` for a stubbed system,
 *   `Story.failed(...)` for a real one), or a story gives the system a test
 *   Layer whose op fails with it (the story names the system, has the op as a
 *   key or a method, and builds the error).
 *
 * The rule reads the story files' text, so it does not tell `given` from
 * `then`, and does not see which branches run.
 */
export const storyCoverage: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Every command, rejection and declared external error appears in a story.",
    },
    messages: {
      command:
        "No story sends the command `{{name}}` or shows one of its events. Add a story for its happy path (`Story.when(ref, new {{name}}(...))`) and for each rejection.",
      rejection:
        "No story asserts the rejection `{{name}}`. Add a story that ends in `Story.rejected(new {{name}}(...))`.",
      error:
        "No story fails `{{system}}.{{op}}` with its declared error `{{name}}`. Add one with `Story.fail({{system}}.{{op}}, new {{name}}(...))` (a stubbed system) or `Story.failed(...)` (a real one).",
    },
  },
  create(context) {
    return {
      Program(program) {
        const file = domainFile(context, program);
        const blocks = file.blocks.filter(
          (block) =>
            block.kind === "Command" ||
            block.kind === "Rejection" ||
            block.kind === "ExternalSystem",
        );
        if (blocks.length === 0) return;
        const root = packageRoot(context.filename);
        if (root === undefined) return;
        const stories = storyText(root);

        // Rejections a story can assert: listed by a command or saga here, or in another file.
        const assertable = new Set<string>();
        for (const block of file.blocks) {
          if (block.kind === "Command" || block.kind === "Saga") {
            file.rejectsOf(block.name)?.forEach((name) => assertable.add(name));
          }
        }
        for (const [other, names] of storyRejections(root)) {
          if (other !== context.filename) names.forEach((name) => assertable.add(name));
        }

        for (const block of blocks) {
          if (block.kind === "ExternalSystem") {
            for (const [op, error, node] of declaredErrors(block)) {
              const members = errorMembers(file, context.filename, error);
              const covered = members.some(
                (member) =>
                  (built(member).test(stories) && failStep(block.name, op).test(stories)) ||
                  storyTexts(root).some((text) => fakeFails(text, block.name, op, member)),
              );
              if (covered) continue;
              context.report({
                node,
                messageId: "error",
                data: { system: block.name, op, name: error },
              });
            }
            continue;
          }
          if (block.kind === "Rejection" && !assertable.has(block.name)) continue;
          const names =
            block.kind === "Command"
              ? [
                  block.name,
                  ...arrayIdentifiers(getProperty(block.definition, "events")?.value).map(
                    (id) => id.name,
                  ),
                ]
              : [block.name];
          const used = names.some((name) => built(name).test(stories));
          if (!used) {
            context.report({
              node: block.id,
              messageId: block.kind === "Command" ? "command" : "rejection",
              data: { name: block.name },
            });
          }
        }
      },
    };
  },
};
