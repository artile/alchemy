# @alchemy.run/oxlint-plugin-domain

oxlint rules for [`@alchemy.run/domain`](../domain) models. They check the rules of the `alchemy-domain` skill (`packages/domain/skills/alchemy-domain`) at lint time.

## Install

```sh
pnpm add -D oxlint @alchemy.run/oxlint-plugin-domain
```

The plugin is an oxlint [JS plugin](https://oxc.rs/docs/guide/usage/linter/js-plugins). It is tested with oxlint 1.87.

## Enable it

```ts
// oxlint.config.ts
import { defineConfig } from "oxlint";
import {
  domainRules,
  layoutRules,
  serverRules,
  strictRules,
} from "@alchemy.run/oxlint-plugin-domain/configs";

export default defineConfig({
  jsPlugins: ["@alchemy.run/oxlint-plugin-domain"],
  overrides: [
    { files: ["packages/domain/src/**"], rules: { ...domainRules, ...layoutRules, ...strictRules } },
    { files: ["packages/server/src/**"], rules: serverRules },
  ],
});
```

| Set | Rules | Use on |
| --- | --- | --- |
| `domainRules` | The rules that read the model exactly. All errors. | The domain package's source |
| `layoutRules` | The file layout of layout.md: `block-file-name`, `one-block-per-file`, `aggregate-id-file`, `relative-import-extension`, `no-barrel-file`. All warn. | The domain package's source, when it follows that layout |
| `serverRules` | `no-chained-provide` | The server package, tests |
| `strictRules` | `deterministic-command-ids`, `redacted-secrets`, `story-coverage`. They guess from names and text, so they can be wrong. All warn. | Optional, on top of either set |

Rule ids use the plugin name `alchemy-domain` (`"alchemy-domain/no-throw": "error"`). Turn single rules off or change their level in `rules` as usual.

## Rules

| Rule | Set | Level | Source |
| --- | --- | --- | --- |
| [`domain-imports`](#domain-imports) | domain | error | SKILL.md, Conventions |
| [`pure-decide-evolve`](#pure-decide-evolve) | domain | error | SKILL.md, Rules |
| [`evolve-only-applies`](#evolve-only-applies) | domain | error | SKILL.md, Rules |
| [`rejects-listed`](#rejects-listed) | domain | error | SKILL.md, Rules |
| [`no-throw`](#no-throw) | domain | error | SKILL.md, Rules |
| [`no-cross-aggregate-import`](#no-cross-aggregate-import) | domain | error | SKILL.md, layout.md |
| [`policy-no-saga-wait`](#policy-no-saga-wait) | domain | error | SKILL.md, Rules |
| [`no-chained-provide`](#no-chained-provide) | domain, server | error | SKILL.md, Rules |
| [`block-file-name`](#block-file-name) | layout | warn | SKILL.md, Conventions |
| [`one-block-per-file`](#one-block-per-file) | layout | warn | SKILL.md, Conventions |
| [`aggregate-id-file`](#aggregate-id-file) | layout | warn | SKILL.md, Conventions |
| [`relative-import-extension`](#relative-import-extension) | layout | warn | layout.md |
| [`no-barrel-file`](#no-barrel-file) | layout | warn | layout.md |
| [`deterministic-command-ids`](#deterministic-command-ids) | strict | warn | SKILL.md, Rules |
| [`redacted-secrets`](#redacted-secrets) | strict | warn | SKILL.md, Rules |
| [`story-coverage`](#story-coverage) | strict | warn | SKILL.md, Checklist; testing.md |

### `domain-imports`

The domain package imports only `@alchemy.run/domain`, `effect` and its own files. Type-only imports of `alchemy` are allowed (a port may require `RuntimeContext`).

Options: `allow` (more packages), `allowTypes` (more type-only packages, replaces `alchemy`), `allowPaths` (directories a relative import may leave the package for), `forbidPaths` (directories no import may reach, even inside the package), `boundary` (see below). Paths are absolute or relative to the working directory, and may be globs of directories (`*` is one segment, `**` any number): `"src/**/server"`.

An import through a `compilerOptions.paths` alias of the nearest `tsconfig.json` (`@/billing/money`) is checked like a relative one, by the file it points to. An app that keeps each domain in a folder (`src/billing/domain/`) instead of a package sets `boundary: "domain"`: the nearest directory above the file with that name is the domain, and an import may not leave it.

```ts
// src/billing/domain/invoice.aggregate.ts, with "@/*": ["./src/*"] and boundary: "domain"
import { InvoiceId } from "@/billing/domain/invoice.id"; // ok
import { db } from "@/billing/server/db"; // error: leaves the domain folder
```

```ts
import * as Domain from "@alchemy.run/domain"; // ok
import * as Schema from "effect/Schema"; // ok
import type { RuntimeContext } from "alchemy"; // ok
import * as Cloudflare from "@alchemy.run/cloudflare"; // error
import { Money } from "../../server/src/Money.ts"; // error: leaves the package
```

### `pure-decide-evolve`

An aggregate's `decide`, `evolve` and `reply`, and a view's `evolve`, `emit`, `computed` and `keyOf`, read no clock, randomness, `process`, `fetch`, timers or `console`. The rule follows calls into local helpers.

```ts
decide: { WithdrawMoney: (s, cmd, { now }) => [new MoneyWithdrawn({ at: now })] }, // ok
decide: { WithdrawMoney: (s, cmd) => [new MoneyWithdrawn({ at: Date.now() })] }, // error
```

### `evolve-only-applies`

An `evolve` handler returns the next state: no Effect, no generator or `async`, no rejection, no new event.

```ts
evolve: { MoneyWithdrawn: (s, e) => ({ ...s, balance: e.balanceAfter }) }, // ok
evolve: { MoneyWithdrawn: (s) => (s.open ? s : new NotOpen()) }, // error
```

### `rejects-listed`

Each rejection a `decide` handler builds (also in local helpers it calls) is in its command's `rejects`. The command may be in another file. The same check runs for a view's or stream's `validate` and an aggregate's `read.validate`. A `rejects` the rule cannot read (a shared constant, a spread) is skipped.

```ts
export class WithdrawMoney extends Domain.Command("WithdrawMoney", { rejects: [NotOpen] }) {}

decide: { WithdrawMoney: (s) => (s.open ? [] : new NotOpen()) }, // ok
decide: { WithdrawMoney: (s) => (s.frozen ? new Frozen() : []) }, // error: Frozen is not listed
```

### `no-throw`

No `throw` in the domain. Reject invalid commands in `decide` with a declared tagged error. `evolve` and `reply` are total. `evolve` leaves the state unchanged when an event cannot apply. The rule also reports throws in helpers.

```ts
const isOpen = (s: AccountState) => s._tag === "Open";

decide: { WithdrawMoney: (s) => (isOpen(s) ? [] : new NotOpen()) }, // ok
evolve: {
  MoneyWithdrawn: (s, e) => isOpen(s) ? { ...s, balance: e.balanceAfter } : s, // ok
},

const mustBeOpen = (s: AccountState) => {
  if (!isOpen(s)) throw new Error("closed"); // error, also when written inside evolve
  return s;
};
```

### `no-cross-aggregate-import`

A file that declares an aggregate does not import another aggregate by value. Connect aggregates with a policy or a saga. Type-only imports are allowed, and so is an aggregate that only a policy, saga or projection declared in the same file uses (in its definition or its `toLayer(...)`).

```ts
// Account.aggregate.ts
import type { Customer } from "../Customer/Customer.aggregate.ts"; // ok
import { Customer } from "../Customer/Customer.aggregate.ts"; // error
```

### `policy-no-saga-wait`

A policy starts or signals a saga; it does not read a run's `result` or call `DurableDeferred.await`. The rule checks a whole `.policy.ts` file, and elsewhere only the arguments of `<Policy>.toLayer(...)`.

```ts
yield* executions.start(source, { amount: event.amount }); // ok
const run = yield* executions.start(source, {});
yield* run.result; // error
```

### `no-chained-provide`

One `Effect.provide` per effect. Merge the layers and provide them once. `Effect.provideService` is not counted.

```ts
program.pipe(Effect.provide(Layer.mergeAll(Handlers, Store))); // ok
program.pipe(Effect.provide(Handlers), Effect.provide(Store)); // error
```

### `block-file-name`

A block lives in `<Noun>.<kind>.ts`, named after the block. The kinds are `.aggregate`, `.command`, `.view`, `.policy`, `.saga`, `.projection`, `.stream`, `.external`, `.api`, `.model`, `.middleware`, `.context` and `.rejection`. A kind-suffixed file declares a block of its kind. Events and rejections may sit in their command's file. Test files are skipped.

```ts
// Account/WithdrawMoney.command.ts
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {}) {} // ok
// Account/Withdraw.command.ts
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {}) {} // warn
```

### `one-block-per-file`

One block per file. Events and rejections may join it. A `.rejection.ts` file holds one rejection. Test files are skipped.

```ts
// Account/Account.aggregate.ts
export class Account extends Domain.Aggregate("Account", {}) {} // ok
export class Statement extends Domain.View("Statement", {}) {} // warn: a second block
```

### `aggregate-id-file`

`<Aggregate>.aggregate.ts` has a sibling `<Aggregate>.id.ts` and takes its `id` from it. An aggregate keyed by a value that already exists (`UsernameClaim` keyed by `Username`, or by another aggregate's id) needs no id file. Test files are skipped.

```ts
// Account/Account.aggregate.ts, next to Account.id.ts
import { AccountId } from "./Account.id.ts"; // ok
// Transfer/Transfer.aggregate.ts, no Transfer.id.ts
export class Transfer extends Domain.Aggregate("Transfer", { id: Schema.String }) {} // warn
```

### `relative-import-extension`

Relative imports end in `.ts`.

```ts
import { AccountId } from "./Account.id.ts"; // ok
import { AccountId } from "./Account.id"; // warn
```

### `no-barrel-file`

No file that only re-exports other files.

```ts
// index.ts
export * from "./Account/Account.aggregate.ts"; // warn, when the file holds nothing else
```

### `deterministic-command-ids`

A policy or projection handler runs at least once, so a second run must make the same ids:

- randomness (`Math.random`, `crypto.randomUUID`, `Random.*`) is reported wherever the handler reads it;
- a clock read (`Date.now`, `DateTime.now`, `Clock.*`) is reported only when it reaches an id: a `commandId`, the target of `send`, `schedule` or `start`, or a property named `id`, `key` or `<name>Id`, directly or through a local variable. Reading the time to choose what to do, or when a timer is due, is fine;
- a constant `commandId` in `send` is reported: a target runs only the first command with an id. In `schedule` the `commandId` names the timer, so a constant there is one timer per aggregate.

```ts
yield* accounts.send(ref, cmd, { commandId: `${envelope.stream}:${envelope.seq}` }); // ok
yield* accounts.schedule(ref, new Remind({}), { after: "1 hour", commandId: "remind" }); // ok: the timer's name
yield* accounts.send(ref, cmd, { commandId: crypto.randomUUID() }); // warn
yield* accounts.send(ref, cmd, { commandId: `credit:${Date.now()}` }); // warn
yield* accounts.send(ref, cmd, { commandId: "credit" }); // warn
```

### `redacted-secrets`

A schema field named like a secret (`password`, `apiKey`, `token`, `clientSecret`, `pin`, `otp`, …) is `Schema.Redacted`. A name that ends in a reference word is not the secret: `tokenId`, `passcodeIds`, `passwordName`, `pinCount`, `secretVersion`, `tokenExpiresAt`. Options: `names` (more names), `ignore` (names to skip).

```ts
{ password: Schema.Redacted(Schema.String) } // ok
{ password: Schema.String } // warn
```

### `story-coverage`

Each block appears in a story of its package (a test file that imports `@alchemy.run/domain/Story`):

- a command is sent, or one of its events is built;
- a rejection that a command or saga lists in `rejects` is built (`Story.rejected(new X())`, a saga's `Rejected` status). A rejection only a view or a read returns is skipped: Api tests cover it;
- each `error:` an external system op declares is built and passed to `Story.fail` (a stubbed system) or `Story.failed` (a real one) for that op, or a story gives the system a test Layer whose op fails with it (the story names the system, has the op as a key or a method, and builds the error).

```ts
// Payments.external.ts
export class Payments extends Domain.ExternalSystem("Payments", {
  refund: { args: {}, success: {}, error: RefundDeclined },
}) {}

// Bank.story.test.ts: covers Payments.refund
Story.call(Payments.refund, { settlementId: "st_1" }),
Story.fail(Payments.refund, new RefundDeclined({ reason: "card-closed" })),
```

## File names

`block-file-name`, `one-block-per-file` and `aggregate-id-file` take the same options:

- `fileCase`: `"pascal"` (default, `WithdrawMoney.command.ts`) or `"kebab"` (`withdraw-money.command.ts`, `account.id.ts`).
- `messagesFile`: a suffix, e.g. `"messages"`. Then `<noun>.messages.ts` may hold the commands, events and rejections of one aggregate together, and no other block.

```ts
const naming = ["warn", { fileCase: "kebab", messagesFile: "messages" }];
rules: {
  "alchemy-domain/block-file-name": naming,
  "alchemy-domain/one-block-per-file": naming,
  "alchemy-domain/aggregate-id-file": ["warn", { fileCase: "kebab" }],
}
```

## Limits

oxlint JS rules see one file and no types. The rules that need a second file (`rejects-listed`, `evolve-only-applies`, `no-cross-aggregate-import`, `aggregate-id-file`, `story-coverage`) read it from disk and scan its text for the shapes the skill prescribes (`export class X extends Domain.Y(...)`). They follow relative imports and `compilerOptions.paths` aliases of the nearest `tsconfig.json`, not package imports or re-exports. `story-coverage` reads story text, so it does not tell `given` from `then` and does not see which branches run.

## Test

```sh
pnpm -C packages/oxlint-plugin-domain test
```

The tests use oxlint's `RuleTester` on Node's test runner (`RuleTester` does not run on Bun).
