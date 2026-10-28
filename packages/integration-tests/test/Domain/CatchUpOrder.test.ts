import * as Domain from "@alchemy.run/domain";
import * as CatchUp from "@alchemy.run/domain/CatchUp";
import * as InMemory from "@alchemy.run/domain/InMemory";
import type { Delivery } from "@alchemy.run/domain/Platform";
import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

// Order across aggregates when a projection added later catches up.
// Each test compares a projection that saw the events live with the same
// projection added in a later deploy.

// ---------------------------------------------------------------- an order and its stock

class Placed extends Domain.Event("Placed", {}) {}
class Amended extends Domain.Event("Amended", {}) {}
class Place extends Domain.Command("Place", {
  target: Schema.String,
  input: {},
  events: [Placed],
}) {}
/** Places and amends in one commit: two events, one clock tick apart. */
class Rush extends Domain.Command("Rush", {
  target: Schema.String,
  input: {},
  events: [Placed, Amended],
}) {}
class Amend extends Domain.Command("Amend", {
  target: Schema.String,
  input: {},
  events: [Amended],
}) {}
class Order extends Domain.Aggregate("Order", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Place, Amend, Rush],
  decide: {
    Place: () => [new Placed()],
    Amend: () => [new Amended()],
    Rush: () => [new Placed(), new Amended()],
  },
  evolve: { Placed: (s) => s, Amended: (s) => s },
}) {}

class Reserved extends Domain.Event("Reserved", { order: Schema.String }) {}
class Reserve extends Domain.Command("Reserve", {
  target: Schema.String,
  input: { order: Schema.String },
  events: [Reserved],
}) {}
// Named so its streams sort before `Order/...`: a tie on the clock would put
// the effect first, so only the cause clock keeps it after its cause.
class Stock extends Domain.Aggregate("Inventory", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Reserve],
  decide: { Reserve: (_, cmd) => [new Reserved({ order: cmd.order })] },
  evolve: { Reserved: (s) => s },
}) {}

/** Every placed order reserves stock: `Reserved` is caused by `Placed`. */
class ReserveStock extends Domain.Policy("ReserveStock", { from: [Order], on: [Placed] }) {}
const ReserveStockLive = ReserveStock.toLayer(
  Effect.gen(function* () {
    const stock = yield* Stock;
    return Effect.fn(function* ({ source }) {
      yield* stock.send("sku-1", new Reserve({ order: source.id }));
    });
  }),
);

// ---------------------------------------------------------------- two identical feeds

/** What each projection received, by projection name, in order. */
class Feeds extends Context.Service<Feeds, Ref.Ref<Record<string, ReadonlyArray<string>>>>()(
  "Test/Feeds",
) {}

const feed = (name: string) => {
  class Feed extends Domain.Projection(name, {
    from: [Order, Stock],
    key: Schema.String,
    keyOf: { Placed: () => "all", Amended: () => "all", Reserved: () => "all" },
    on: [Placed, Amended, Reserved],
  }) {}
  const live = Feed.toLayer(
    Effect.gen(function* () {
      const feeds = yield* Feeds;
      return Effect.fn(function* (batch) {
        const lines = batch.map(({ event, source }) =>
          event._tag === "Reserved"
            ? `reserved ${event.order}`
            : `${event._tag.toLowerCase()} ${(source as { readonly id: string }).id}`,
        );
        yield* Ref.update(feeds, (all) => ({ ...all, [name]: [...(all[name] ?? []), ...lines] }));
      });
    }),
  );
  return { Feed, live };
};

const Live = feed("Live");
const Later = feed("Later");

/** Deploy 1 has the live feed; deploy 2 adds the later one. */
const models = (
  aggregates: readonly [typeof Order | typeof Stock, typeof Order | typeof Stock],
) => {
  class Before extends Domain.Model("Shop", {
    aggregates,
    policies: [ReserveStock],
    projections: [Live.Feed],
  }) {}
  class After extends Domain.Model("Shop", {
    aggregates,
    policies: [ReserveStock],
    projections: [Live.Feed, Later.Feed],
  }) {}
  return { Before, After };
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const shop = () => {
  const clock = { now: 0 };
  const hosted = InMemory.make({ manual: true, now: () => clock.now, catchUpWindow: HOUR });
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* hosted.control.drain;
      if (yield* hosted.control.idle) return;
      yield* Effect.sleep("1 millis");
    }
  });
  const deploy = <A, E, R, P, PE, PR>(
    model: { readonly layer: (policies: any) => Layer.Layer<any, any, any> },
    policies: Layer.Layer<P, PE, PR>,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.tap(() => settle),
      Effect.provide(model.layer(policies).pipe(Layer.provide(hosted.layer))),
    );
  return { clock, settle, deploy };
};

const place = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* Order).send(id, new Place({}));
  });
const amend = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* Order).send(id, new Amend({}));
  });

/** Run `history` on deploy 1, add the later feed in deploy 2, return both feeds. */
const replay = <R>(
  aggregates: readonly [typeof Order | typeof Stock, typeof Order | typeof Stock],
  history: (s: ReturnType<typeof shop>) => Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    const s = shop();
    const { Before, After } = models(aggregates);
    yield* s.deploy(Before, Layer.mergeAll(ReserveStockLive, Live.live), history(s));
    yield* s.deploy(After, Layer.mergeAll(ReserveStockLive, Live.live, Later.live), s.settle);
    const feeds = yield* Ref.get(yield* Feeds);
    return { live: feeds.Live ?? [], later: feeds.Later ?? [] };
  }).pipe(Effect.provide(Layer.effect(Feeds, Ref.make({}))));

describe("Domain catch-up order across aggregates", () => {
  it.live("an event a policy caused replays after its cause", () =>
    Effect.gen(function* () {
      // Same commit time: the clock does not move between cause and effect.
      const { live, later } = yield* replay([Stock, Order], (s) =>
        place("o-1").pipe(Effect.andThen(s.settle)),
      );
      expect(live).toEqual(["placed o-1", "reserved o-1"]);
      expect(later).toEqual(live);
    }),
  );

  it.live("replay order does not depend on how the model lists its aggregates", () =>
    Effect.gen(function* () {
      const history = (s: ReturnType<typeof shop>) => place("o-1").pipe(Effect.andThen(s.settle));
      const a = yield* replay([Order, Stock], history);
      const b = yield* replay([Stock, Order], history);
      expect(b.later).toEqual(a.later);
    }),
  );

  it.live("history inside one window replays in time order, not instance by instance", () =>
    Effect.gen(function* () {
      const { live, later } = yield* replay([Order, Stock], (s) =>
        Effect.gen(function* () {
          const step = (minutes: number, effect: Effect.Effect<void, never, any>) =>
            Effect.sync(() => {
              s.clock.now = minutes * MINUTE;
            }).pipe(Effect.andThen(effect), Effect.andThen(s.settle));
          yield* step(10, place("o-1"));
          yield* step(20, place("o-2"));
          yield* step(30, amend("o-1"));
        }),
      );
      expect(live).toEqual([
        "placed o-1",
        "reserved o-1",
        "placed o-2",
        "reserved o-2",
        "amended o-1",
      ]);
      expect(later).toEqual(live);
    }),
  );

  it.live("a view key fed by many instances replays in its own order", () =>
    Effect.gen(function* () {
      // The view's inputs have clocks 0, 1, 0; each entry ticks past the
      // previous one, so its entries have clocks 0, 1, 2, in seq order.
      class Log extends Domain.View("Log", {
        from: [Order],
        key: Schema.String,
        keyOf: { Placed: () => "all", Amended: () => "all" },
        state: Schema.Struct({}),
        initial: {},
        evolve: { Placed: (s) => s, Amended: (s) => s },
      }) {}
      class FromLog extends Domain.Projection("FromLog", {
        from: [Log],
        key: Schema.String,
        keyOf: { Placed: () => "all", Amended: () => "all" },
        on: [Placed, Amended],
      }) {}
      const FromLogLive = FromLog.toLayer(
        Effect.gen(function* () {
          const feeds = yield* Feeds;
          return Effect.fn(function* (batch) {
            const tags = batch.map(({ event }) => event._tag);
            yield* Ref.update(feeds, (all) => ({
              ...all,
              FromLog: [...(all.FromLog ?? []), ...tags],
            }));
          });
        }),
      );
      class Before extends Domain.Model("Shop", { aggregates: [Order], views: [Log] }) {}
      class After extends Domain.Model("Shop", {
        aggregates: [Order],
        views: [Log],
        projections: [FromLog],
      }) {}
      const s = shop();
      yield* s.deploy(
        Before,
        Layer.empty,
        Effect.gen(function* () {
          yield* (yield* Order).send("o-1", new Rush({}));
          yield* s.settle;
          yield* place("o-2");
        }),
      );
      yield* s.deploy(After, FromLogLive, s.settle);
      const feeds = yield* Ref.get(yield* Feeds);
      expect(feeds.FromLog).toEqual(["Placed", "Amended", "Placed"]);
    }).pipe(Effect.provide(Layer.effect(Feeds, Ref.make({})))),
  );

  it.live("an effect of a view entry replays after that entry", () =>
    Effect.gen(function* () {
      // A policy on a view's entries reserves stock, on a new instance each time.
      class Log extends Domain.View("Log", {
        from: [Order],
        key: Schema.String,
        keyOf: { Placed: () => "all", Amended: () => "all" },
        state: Schema.Struct({}),
        initial: {},
        evolve: { Placed: (s) => s, Amended: (s) => s },
      }) {}
      class OnLog extends Domain.Policy("OnLog", { from: [Log], on: [Placed] }) {}
      const OnLogLive = OnLog.toLayer(
        Effect.gen(function* () {
          const stock = yield* Stock;
          let n = 0;
          return Effect.fn(function* () {
            yield* stock.send(`sku-${n++}`, new Reserve({ order: "any" }));
          });
        }),
      );
      class Tags extends Domain.Projection("Tags", {
        from: [Log, Stock],
        key: Schema.String,
        keyOf: { Placed: () => "all", Amended: () => "all", Reserved: () => "all" },
        on: [Placed, Amended, Reserved],
      }) {}
      const TagsLive = Tags.toLayer(
        Effect.gen(function* () {
          const feeds = yield* Feeds;
          return Effect.fn(function* (batch) {
            const tags = batch.map(({ event }) => event._tag);
            yield* Ref.update(feeds, (all) => ({ ...all, Tags: [...(all.Tags ?? []), ...tags] }));
          });
        }),
      );
      class Before extends Domain.Model("Shop", {
        aggregates: [Order, Stock],
        views: [Log],
        policies: [OnLog],
      }) {}
      class After extends Domain.Model("Shop", {
        aggregates: [Order, Stock],
        views: [Log],
        policies: [OnLog],
        projections: [Tags],
      }) {}
      const s = shop();
      const policies = Layer.mergeAll(OnLogLive);
      yield* s.deploy(
        Before,
        policies,
        Effect.gen(function* () {
          yield* (yield* Order).send("o-1", new Rush({}));
          yield* s.settle;
          yield* place("o-2");
        }),
      );
      yield* s.deploy(After, Layer.mergeAll(OnLogLive, TagsLive), s.settle);
      const feeds = yield* Ref.get(yield* Feeds);
      // Each Reserved after the Placed that caused it.
      expect(feeds.Tags).toEqual(["Placed", "Reserved", "Amended", "Placed", "Reserved"]);
    }).pipe(Effect.provide(Layer.effect(Feeds, Ref.make({})))),
  );

  it("a round merge keeps each source's own order", () => {
    // Entries a view stored before clocks fall back to `at`, which can fall as seq rises.
    const at = (source: string, seq: number, ms: number) =>
      ({ source, seq, envelope: { at: ms } }) as unknown as Delivery;
    const merged = CatchUp.mergeBySource(
      [at("Log/all", 1, 0), at("Log/all", 2, 5), at("Log/all", 3, 1), at("Order/o-9", 1, 3)],
      (d) => d,
    );
    expect(merged.map((d) => `${d.source}#${d.seq}`)).toEqual([
      "Log/all#1",
      "Order/o-9#1",
      "Log/all#2",
      "Log/all#3",
    ]);
  });
});
