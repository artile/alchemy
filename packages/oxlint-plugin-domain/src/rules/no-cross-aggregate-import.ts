import { memberPath, walk } from "../ast.ts";
import { domainFile, kindOfPath } from "../file.ts";
import { resolveImport } from "../files.ts";
import { moduleIndex } from "../files.ts";
import type { Rule } from "../types.ts";

/**
 * SKILL.md: "A rule that spans aggregates never becomes a cross-aggregate
 * transaction." and layout.md: "never by importing each other's aggregates".
 *
 * A file that declares an aggregate does not import another aggregate (by
 * value). Connect aggregates with a policy or a saga, or give the invariant its
 * own aggregate. Type-only imports are allowed, and so is an aggregate used
 * only by a policy, saga or projection declared in the same file (its
 * `Domain.Policy(...)` call or its `toLayer(...)`): that handler connects the
 * aggregates as the skill says.
 */
const HANDLERS = new Set(["Policy", "Saga", "Projection"]);

export const noCrossAggregateImport: Rule = {
  meta: {
    type: "problem",
    docs: { description: "An aggregate does not import another aggregate." },
    messages: {
      cross:
        "Aggregate `{{aggregate}}` imports the aggregate `{{other}}`. One command changes one aggregate: connect them with a policy or a saga, or give the shared invariant its own aggregate.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const file = domainFile(context, program);
        const aggregate = file.blocks.find((block) => block.kind === "Aggregate");
        if (aggregate === undefined) return;

        // The code of the handlers declared here: their definitions and their `toLayer(...)`.
        const handlers = new Set(
          file.blocks.filter((block) => HANDLERS.has(block.kind)).map((block) => block.name),
        );
        const areas: Array<readonly [number, number]> = file.blocks
          .filter((block) => handlers.has(block.name))
          .map((block) => [block.call.start, block.call.end] as const);
        const uses = new Map<string, Array<number>>();
        walk(program, (node) => {
          if (node.type === "ImportDeclaration") return false;
          if (node.type === "CallExpression") {
            const path = memberPath(node.callee);
            if (path?.length === 2 && path[1] === "toLayer" && handlers.has(path[0]!)) {
              areas.push([node.start, node.end]);
            }
          }
          if (node.type === "Identifier") {
            const list = uses.get(node.name) ?? [];
            list.push(node.start);
            uses.set(node.name, list);
          }
        });
        const onlyInHandlers = (name: string) => {
          const list = uses.get(name) ?? [];
          return (
            list.length > 0 &&
            list.every((at) => areas.some(([start, end]) => at >= start && at < end))
          );
        };
        for (const statement of program.body) {
          if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
          const source: string = statement.source.value;
          const target = resolveImport(context.filename, source);
          const index = target === undefined ? undefined : moduleIndex(target);
          for (const specifier of statement.specifiers) {
            if (specifier.importKind === "type") continue;
            const imported =
              specifier.type === "ImportSpecifier"
                ? (specifier.imported.name ?? specifier.imported.value)
                : undefined;
            const isAggregate =
              (imported !== undefined && index?.kinds.get(imported) === "Aggregate") ||
              (index === undefined && kindOfPath(source) === "Aggregate");
            if (isAggregate && !onlyInHandlers(specifier.local.name)) {
              context.report({
                node: specifier,
                messageId: "cross",
                data: { aggregate: aggregate.name, other: specifier.local.name },
              });
            }
          }
        }
      },
    };
  },
};
