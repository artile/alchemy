import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Ledger, LedgerOffline } from "../src/Ledger/Ledger.external.ts";

// A test Layer for the system: its `post` op fails with the declared error.
export const offline = Layer.succeed(Ledger, {
  post: () => Effect.fail(new LedgerOffline({})),
});

export const story = Story.make(Bank, { layer: Layer.mergeAll(BankHandlers, offline) });

// A story helper that builds a rejection from its class and fields.
const rejection = (cls: unknown, fields: unknown) => ({ cls, fields });
export const overdrawn = rejection(Overdrawn, { amount: 1 });
