import { memberPath, nondeterminism, propertyName, unwrap, walk, walkWithHelpers } from "../ast.ts";
import { type DomainFile, domainFile } from "../file.ts";
import type { Node, Rule } from "../types.ts";

const HANDLERS = new Set(["Policy", "Projection"]);

/** Client methods whose first argument names the target and whose options carry a `commandId`. */
const SENDS = new Set(["send", "schedule", "start"]);

/** A clock read: the same input gives a different value on a second run. */
const CLOCK = /^(?:new Date\(\)|Date\(\)|Date\.now\(\)|performance\.now\(\)|Clock\.|DateTime\.now)/;

/** A property that names a row or a command: `id`, `rowId`, `key`, `commandId`. */
const isIdName = (name: string | undefined): boolean =>
  name !== undefined && (name === "id" || name === "key" || /[a-z]Id$/.test(name));

/** The value of `{ commandId: ... }` when it is a literal: the same text for every input. */
const isConstant = (value: Node | undefined): boolean =>
  value?.type === "Literal" ||
  (value?.type === "TemplateLiteral" && value.expressions.length === 0);

/**
 * SKILL.md: "Policies and projections run at least once. Make their effects
 * idempotent: commands sent from a handler get deterministic ids, and stores
 * key rows by `stream:seq`."
 *
 * Inside a policy's or projection's `toLayer(...)`:
 *
 * - randomness (`Math.random`, `crypto.randomUUID`, `Random.*`) is reported
 *   wherever it is read: a second run draws a different value;
 * - a clock read (`Date.now`, `DateTime.now`, `Clock.*`) is reported only when
 *   it reaches an id: a `commandId`, the target of `send` / `schedule` /
 *   `start`, or a property named `id`, `key` or `<name>Id`, directly or through
 *   a local variable. Reading the time to decide what to do, or to compute when
 *   a timer is due, is fine: the deterministic id deduplicates the second run;
 * - a constant `commandId` in `send` is reported: commands are deduplicated per
 *   target by id, so the target runs only the first command with that id. In
 *   `schedule` the `commandId` names the timer, so a constant is the usual
 *   "one timer per aggregate, armed again by each trigger".
 */
export const deterministicCommandIds: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Policy and projection handlers derive ids from their input, never from the clock or randomness.",
    },
    messages: {
      random:
        "`{{handler}}` runs at least once, but reads `{{what}}`: a retry sends a different command or writes a different row. Derive ids from the event (`envelope.stream`, `envelope.seq`, the source id), or let the platform assign the `commandId`.",
      clock:
        "`{{handler}}` runs at least once, but builds an id from `{{what}}`: a retry gets a different id, so it is not deduplicated. Derive the id from the event (`envelope.stream`, `envelope.seq`, the event's own time).",
      constant:
        "`commandId` in `{{handler}}` is a constant: the target runs only the first command with this id, and later events send nothing. Derive it from the event, unless one command per target is what you mean.",
    },
  },
  create(context) {
    let file: DomainFile | undefined;
    return {
      Program(program) {
        file = domainFile(context, program);
      },
      CallExpression(call) {
        const path = memberPath(call.callee);
        if (file === undefined || path?.length !== 2 || path[1] !== "toLayer") return;
        const handler = path[0]!;
        const kind = file.kindOf(handler);
        if (kind === undefined || !HANDLERS.has(kind)) return;

        // Names bound from a clock read: `const now = yield* DateTime.now`.
        const clockNames = new Map<string, string>();
        // Option objects of `schedule(...)`, and their properties: a `commandId` there names a timer.
        const timerOptions = new Set<Node>();
        const timerProperties = new Set<Node>();
        // Expressions that become an id: targets of sends, and id-named values.
        const ids: Array<Node> = [];

        for (const argument of call.arguments) {
          walkWithHelpers(argument, file.helpers, (node) => {
            if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
              let clock: string | undefined;
              walk(node.init, (child) => {
                const what = nondeterminism(child);
                if (what !== undefined && CLOCK.test(what)) clock ??= what;
              });
              if (clock !== undefined) clockNames.set(node.id.name, clock);
            }
            if (node.type === "CallExpression") {
              const method = memberPath(unwrap(node.callee))?.at(-1);
              if (method !== undefined && SENDS.has(method)) {
                if (node.arguments[0] !== undefined) ids.push(node.arguments[0]);
                const options = unwrap(node.arguments.at(-1));
                if (method === "schedule" && options?.type === "ObjectExpression") {
                  timerOptions.add(options);
                }
              }
            }
            if (node.type === "ObjectExpression" && timerOptions.has(node)) {
              for (const property of node.properties) timerProperties.add(property);
            }
            if (node.type === "Property" && isIdName(propertyName(node))) ids.push(node.value);

            const what = nondeterminism(node);
            if (what !== undefined && !CLOCK.test(what)) {
              context.report({ node, messageId: "random", data: { handler, what } });
              return;
            }
            if (
              node.type === "Property" &&
              propertyName(node) === "commandId" &&
              !timerProperties.has(node) &&
              isConstant(unwrap(node.value))
            ) {
              context.report({ node: node.value, messageId: "constant", data: { handler } });
            }
          });
        }

        const reported = new Set<Node>();
        for (const id of ids) {
          walk(id, (child) => {
            const what =
              nondeterminism(child) ??
              (child.type === "Identifier" ? clockNames.get(child.name) : undefined);
            if (what === undefined || !CLOCK.test(what) || reported.has(child)) return;
            reported.add(child);
            context.report({ node: child, messageId: "clock", data: { handler, what } });
            return false;
          });
        }
      },
    };
  },
};
