import { domainImports } from "../src/rules/domain-imports.ts";
import { app, bank, tester } from "./tester.ts";

const filename = bank("src/Account/Thing.ts");
const order = app("src/orders/domain/order.aggregate.ts");

tester.run("domain-imports", domainImports, {
  valid: [
    { filename, code: `import * as Domain from "@alchemy.run/domain";` },
    { filename, code: `import { Story } from "@alchemy.run/domain/Story";` },
    { filename, code: `import * as Effect from "effect/Effect"; import { Schema } from "effect";` },
    {
      filename,
      code: `import { AccountId } from "./Account.id.ts"; import { x } from "../Customer/Customer.id.ts";`,
    },
    { filename, code: `import type { RuntimeContext } from "alchemy";` },
    { filename, code: `import { type RuntimeContext } from "alchemy";` },
    {
      filename,
      code: `import { Stripe } from "@acme/payments";`,
      options: [{ allow: ["@acme/payments"] }],
    },
    // An alias import inside the domain folder.
    {
      filename: order,
      code: `import { OrderId } from "@/orders/domain/order.id";`,
      options: [{ boundary: "domain" }],
    },
    // An alias import to a shared pure module the options allow.
    {
      filename: order,
      code: `import { prefix } from "@/shared/ids";`,
      options: [{ boundary: "domain", allowPaths: [app("src/shared")] }],
    },
    // Without a boundary the package is the app, so any of its folders is inside.
    { filename: order, code: `import { db } from "@/server/db";` },
    // A glob in allowPaths.
    {
      filename: order,
      code: `import { prefix } from "@/shared/ids";`,
      options: [{ boundary: "domain", allowPaths: ["fixtures/*/src/shared"] }],
      cwd: import.meta.dirname,
    },
  ],
  invalid: [
    {
      // A forbidden folder, even inside the package.
      filename: order,
      code: `import { db } from "@/server/db";`,
      options: [{ forbidPaths: ["fixtures/**/server"] }],
      cwd: import.meta.dirname,
      errors: [
        { messageId: "reaches", data: { source: "@/server/db", path: "fixtures/**/server" } },
      ],
    },
    {
      filename: order,
      code: `import { db } from "@/server/db";`,
      options: [{ boundary: "domain" }],
      errors: [{ messageId: "outside", data: { source: "@/server/db" } }],
    },
    {
      filename: order,
      code: `import { db } from "../../server/db.ts";`,
      options: [{ boundary: "domain" }],
      errors: [{ messageId: "outside" }],
    },
    {
      filename,
      code: `import * as Cloudflare from "@alchemy.run/cloudflare";`,
      errors: [{ messageId: "forbidden", data: { source: "@alchemy.run/cloudflare" } }],
    },
    { filename, code: `import * as fs from "node:fs";`, errors: [{ messageId: "forbidden" }] },
    { filename, code: `import { Stack } from "alchemy";`, errors: [{ messageId: "forbidden" }] },
    {
      filename,
      code: `import type { RuntimeContext } from "alchemy";`,
      options: [{ allowTypes: [] }],
      errors: [{ messageId: "forbidden" }],
    },
    { filename, code: `export * from "drizzle-orm";`, errors: [{ messageId: "forbidden" }] },
    { filename, code: `const m = await import("stripe");`, errors: [{ messageId: "forbidden" }] },
    { filename, code: `const m = require("stripe");`, errors: [{ messageId: "forbidden" }] },
    {
      filename,
      code: `import { BankWorker } from "../../../server/src/BankWorker.ts";`,
      errors: [{ messageId: "outside" }],
    },
  ],
});

// `allowPaths`: directories a relative import may leave the package for (a shared pure module).
const shared = bank("../shared");

tester.run("domain-imports (allowPaths)", domainImports, {
  valid: [
    {
      filename,
      code: `import { decide } from "../../../shared/pure/decide";`,
      options: [{ allowPaths: [shared] }],
    },
  ],
  invalid: [
    {
      filename,
      code: `import { BankWorker } from "../../../server/src/BankWorker.ts";`,
      options: [{ allowPaths: [shared] }],
      errors: [{ messageId: "outside" }],
    },
    // A sibling folder whose name starts with the allowed one is not inside it.
    {
      filename,
      code: `import { x } from "../../../shared-io/x.ts";`,
      options: [{ allowPaths: [shared] }],
      errors: [{ messageId: "outside" }],
    },
  ],
});
