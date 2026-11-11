/**
 * Spike model (alchemy on NixOS, no Docker): one command, one timer, one two-step saga.
 *
 * - PlaceOrder (command) -> OrderPlaced
 * - policy OnPlaced: schedules ExpireOrder after EXPIRY_AFTER (timer) and starts saga Fulfil
 * - saga Fulfil: step 1 Reserve on Stock, step 2 Confirm on Order
 * - ExpireOrder counts every delivery in `expiries`, so a duplicate timer shows as 2
 */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

export const EXPIRY_AFTER = process.env.SPIKE_EXPIRY_AFTER ?? "20 seconds";

export class OrderPlaced extends Domain.Event("OrderPlaced") {}
export class OrderConfirmed extends Domain.Event("OrderConfirmed") {}
export class OrderExpired extends Domain.Event("OrderExpired") {}
export class Reserved extends Domain.Event("Reserved") {}

export class PlaceOrder extends Domain.Command("PlaceOrder", {
  target: Schema.String,
  events: [OrderPlaced],
}) {}
export class ConfirmOrder extends Domain.Command("ConfirmOrder", {
  target: Schema.String,
  events: [OrderConfirmed],
}) {}
export class ExpireOrder extends Domain.Command("ExpireOrder", {
  target: Schema.String,
  events: [OrderExpired],
}) {}
export class Reserve extends Domain.Command("Reserve", {
  target: Schema.String,
  events: [Reserved],
}) {}

const OrderState = Schema.Struct({
  placed: Schema.Boolean,
  confirmed: Schema.Boolean,
  expiries: Schema.Int,
});

export class Order extends Domain.Aggregate("Order", {
  id: Schema.String,
  state: OrderState,
  initial: { placed: false, confirmed: false, expiries: 0 },
  commands: [PlaceOrder, ConfirmOrder, ExpireOrder],
  decide: {
    PlaceOrder: () => [new OrderPlaced()],
    ConfirmOrder: () => [new OrderConfirmed()],
    ExpireOrder: () => [new OrderExpired()],
  },
  evolve: {
    OrderPlaced: (s) => ({ ...s, placed: true }),
    OrderConfirmed: (s) => ({ ...s, confirmed: true }),
    OrderExpired: (s) => ({ ...s, expiries: s.expiries + 1 }),
  },
}) {}

export class Stock extends Domain.Aggregate("Stock", {
  id: Schema.String,
  state: Schema.Struct({ reserved: Schema.Int }),
  initial: { reserved: 0 },
  commands: [Reserve],
  decide: { Reserve: () => [new Reserved()] },
  evolve: { Reserved: (s) => ({ reserved: s.reserved + 1 }) },
}) {}

export class Fulfil extends Domain.Saga("Fulfil", { key: Schema.String, input: {} }) {}

const FulfilLive = Fulfil.toLayer(
  Effect.gen(function* () {
    const stock = yield* Stock;
    const orders = yield* Order;
    return Effect.fn(function* ({ key }) {
      yield* Activity.make({
        name: "reserve",
        execute: stock.send(key, new Reserve()).pipe(Effect.orDie),
      });
      yield* Activity.make({
        name: "confirm",
        execute: orders.send(key, new ConfirmOrder()).pipe(Effect.orDie),
      });
    });
  }),
);

export class OnPlaced extends Domain.Policy("OnPlaced", { from: Order, on: [OrderPlaced] }) {}

const OnPlacedLive = OnPlaced.toLayer(
  Effect.gen(function* () {
    const orders = yield* Order;
    const fulfil = yield* Fulfil;
    return Effect.fn(function* ({ source }) {
      yield* orders.schedule(source, new ExpireOrder(), {
        after: EXPIRY_AFTER,
        commandId: "expire",
      });
      yield* fulfil.start(source, {});
    });
  }),
);

export class Spike extends Domain.Model("Spike", {
  aggregates: [Order, Stock],
  policies: [OnPlaced],
  sagas: [Fulfil],
}) {}

export const SpikeModel = Spike.layer(Layer.mergeAll(OnPlacedLive, FulfilLive));
