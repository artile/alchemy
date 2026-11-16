/**
 * How building-block files are named. The skill names a file after its block
 * in PascalCase (`WithdrawMoney.command.ts`); a repository whose files are
 * kebab-case sets `fileCase: "kebab"` (`withdraw-money.command.ts`). A
 * repository that keeps the commands, events and rejections of one aggregate
 * together sets `messagesFile` to that file's suffix (`"messages"` →
 * `account.messages.ts`).
 */
import type { Context } from "./types.ts";

export type FileCase = "pascal" | "kebab";

export interface Naming {
  readonly fileCase: FileCase;
  /** The suffix of a grouped messages file (`<noun>.<messagesFile>.ts`), or `undefined`. */
  readonly messagesFile: string | undefined;
}

/** The option schema the naming rules share. */
export const namingSchema: ReadonlyArray<unknown> = [
  {
    type: "object",
    properties: {
      fileCase: { type: "string", enum: ["pascal", "kebab"] },
      messagesFile: { type: "string" },
    },
    additionalProperties: false,
  },
];

export const naming = (context: Context): Naming => {
  const options = (context.options[0] ?? {}) as Partial<Naming>;
  return { fileCase: options.fileCase ?? "pascal", messagesFile: options.messagesFile };
};

/** `WithdrawMoney` → `withdraw-money`; `ATMCard` → `atm-card`. */
export const kebabCase = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();

/** The noun a block's file starts with: the block's name in the file case. */
export const fileNoun = (name: string, fileCase: FileCase): string =>
  fileCase === "kebab" ? kebabCase(name) : name;

/**
 * The nouns a block's file may start with: its name, and its name without a
 * trailing kind word (`NotesModel` → `Notes.model.ts`, `CustomerApi` →
 * `Customer.api.ts` or `CustomerApi.api.ts`).
 */
export const fileNouns = (
  name: string,
  kind: string,
  fileCase: FileCase,
): ReadonlyArray<string> => {
  const word =
    kind === "RequestContext" ? "Context" : kind === "ExternalSystem" ? "External" : kind;
  const stripped =
    name.length > word.length && name.endsWith(word) ? name.slice(0, -word.length) : undefined;
  return stripped === undefined
    ? [fileNoun(name, fileCase)]
    : [fileNoun(name, fileCase), fileNoun(stripped, fileCase)];
};

const MESSAGE_KINDS: ReadonlySet<string> = new Set(["Command", "Event", "Rejection"]);

/** A block a messages file may hold: a command, an event or a rejection. */
export const isMessageKind = (kind: string): boolean => MESSAGE_KINDS.has(kind);
