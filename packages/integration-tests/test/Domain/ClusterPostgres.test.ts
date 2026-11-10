/**
 * The cluster host on Postgres with its tables in schemas, the layout of one
 * database with a schema per owner: the host's tables in the schema named by
 * `Cluster.layer({ schema })`, the cluster's own tables (which take no
 * schema) in the connection's `search_path`. Runs only when the database URL
 * is set:
 *
 *   DOMAIN_TEST_POSTGRES_URL=postgres://user@localhost/domain_cluster_test
 *
 * Every test makes its own two schemas and drops them before and after it
 * runs. The tables keep the default names (`domain_*`, `cluster_*`).
 */
import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as BunClusterSocket from "@effect/platform-bun/BunClusterSocket";
import { PgClient } from "@effect/sql-pg";
import * as RunnerAddress from "effect/cluster/RunnerAddress";
import * as RunnerHealth from "effect/cluster/RunnerHealth";
import * as Runners from "effect/cluster/Runners";
import * as RunnerStorage from "effect/cluster/RunnerStorage";
import * as Sharding from "effect/cluster/Sharding";
import * as ShardingConfig from "effect/cluster/ShardingConfig";
import * as SqlMessageStorage from "effect/cluster/SqlMessageStorage";
import * as SqlRunnerStorage from "effect/cluster/SqlRunnerStorage";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ContractApi,
  Counter,
  eventually,
  ExpireHold,
  Hold,
  hostContract,
  hosted,
  Increment,
} from "./fixtures/HostContract.ts";
import { concurrentCompletion, rollbackBetweenDeletes } from "./fixtures/RetentionRace.ts";

const URL = process.env.DOMAIN_TEST_POSTGRES_URL;

/** The schemas of one test: the host's tables, and the cluster's. */
interface Schemas {
  readonly host: string;
  readonly cluster: string;
}

const schemasOf = (name: string): Schemas => ({
  host: `dct_pgs_${name}_h`,
  cluster: `dct_pgs_${name}_c`,
});

/** A small pool whose `search_path` is the cluster's schema. Each call is a new pool. */
const pool = (s: Schemas, applicationName?: string) =>
  PgClient.layer({
    url: Redacted.make(URL!),
    maxConnections: 4,
    applicationName,
    startupParameters: { search_path: s.cluster },
  });

/**
 * Drop both schemas when the test starts (a crashed run left them) and when
 * it ends; make the cluster's schema, which nothing else creates. The host
 * creates its own.
 */
const clean = (s: Schemas): Layer.Layer<never, never, SqlClient.SqlClient> => {
  const drop = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${s.host} CASCADE`);
    yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${s.cluster} CASCADE`);
  }).pipe(Effect.orDie);
  const make = Effect.gen(function* () {
    yield* drop;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`CREATE SCHEMA ${s.cluster}`).pipe(Effect.orDie);
  });
  return Layer.effectDiscard(Effect.acquireRelease(make, () => drop));
};

const config = { entityMessagePollInterval: "1 second" } as const;

/** One runner that owns every shard; its tables go where `s` says. */
const singleRunner = (s: Schemas, options: Domain.Cluster.Options = {}) =>
  Domain.Cluster.layer({ ...options, schema: s.host }).pipe(
    Layer.provide(
      Sharding.layer.pipe(
        Layer.provideMerge(Runners.layerNoop),
        Layer.provideMerge(
          SqlMessageStorage.layerStorage({}).pipe(
            Layer.provide(SqlMessageStorage.layerMigrations({})),
          ),
        ),
        Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
        Layer.provide(ShardingConfig.layer(config)),
        Layer.provide(Digest.layerWebCrypto),
      ),
    ),
  );

/** A socket runner on `port`, sharing the schemas with the others; the tables come from `migrate`. */
const socketRunner = (s: Schemas, port: number) => {
  const shardingConfig = {
    ...config,
    runnerAddress: Option.some(RunnerAddress.make("localhost", port)),
  };
  return Domain.Cluster.layer({ schema: s.host, migrations: false }).pipe(
    Layer.provide(BunClusterSocket.layer({ storage: "byo", shardingConfig })),
    Layer.provide(
      Layer.mergeAll(SqlMessageStorage.layerStorage({}), SqlRunnerStorage.layerStorage({})),
    ),
    Layer.provide(ShardingConfig.layer(shardingConfig)),
    Layer.provide(Digest.layerWebCrypto),
  );
};

/** The deploy step: every table of the host and the cluster. */
const migrate = (s: Schemas) =>
  Layer.mergeAll(
    Domain.Cluster.layerMigrations({ schema: s.host }),
    SqlMessageStorage.layerMigrations({}),
    SqlRunnerStorage.layerMigrations({}),
  );

const tablesIn = (schema: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      table_name: string;
    }>`SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY table_name`;
    return rows.map((row) => row.table_name);
  });

describe.skipIf(URL === undefined)(
  "Domain.Cluster on Postgres, tables in schemas",
  { tags: ["local"] },
  () => {
    let next = 0;
    /** A host on two new schemas, with one runner and its own pool. */
    const onSchemas = (s: Schemas, options?: Domain.Cluster.Options) =>
      singleRunner(s, options).pipe(Layer.provide(clean(s)), Layer.provideMerge(pool(s)));

    // Every host query names its schema: the pool's search_path holds only the
    // cluster's schema, so a table without its schema is not found.
    hostContract("Cluster on Postgres, tables in schemas", () =>
      onSchemas(schemasOf(`k${next++}`)),
    );

    it.live("the host's tables are in its schema, the cluster's in the search_path", () => {
      const s = schemasOf("layout");
      return Effect.gen(function* () {
        const counters = yield* Counter;
        yield* counters.send("c-1", new Increment({ by: 1 }), { commandId: "one" });
        expect(yield* tablesIn(s.host)).toEqual(
          [
            "aggregates",
            "events",
            "migrations",
            "outbox",
            "projection_inputs",
            "projections",
            "receipts",
            "schedules",
            "stream_entries",
            "streams",
            "view_entries",
            "views",
          ].map((table) => `domain_${table}`),
        );
        const cluster = yield* tablesIn(s.cluster);
        expect(cluster).toContain("cluster_messages");
        expect(cluster).toContain("cluster_replies");
        expect(cluster.some((table) => table.startsWith("domain_"))).toBe(false);
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{
          version: number;
        }>`SELECT version FROM ${sql(`${s.host}.domain_aggregates`)} WHERE name = 'Counter' AND id = 'c-1'`;
        expect(Number(row!.version)).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(hosted(onSchemas(s))));
    });

    for (const [title, race] of [
      [
        "retention: a request that completes during a sweep keeps its message and reply",
        concurrentCompletion,
      ],
      ["retention: a failed message delete rolls back its reply delete", rollbackBetweenDeletes],
    ] as const) {
      it.live(title, () => {
        const name = race === concurrentCompletion ? "race" : "rollback";
        const s = schemasOf(name);
        // The cluster's tables keep their default names, found through the search_path.
        return race(
          { messages: "cluster_messages", replies: "cluster_replies", name: `dct_pgs_${name}` },
          "Domain.Policy/Mirror",
        ).pipe(
          Effect.scoped,
          Effect.provide(
            hosted(
              onSchemas(s, {
                sweep: { intervalMillis: 100, afterMillis: 30_000 },
                retention: { receipts: "forever", cancelled: "forever", messages: 0 },
              }),
            ),
          ),
        );
      });
    }

    it.live(
      "a runner that stops with a timer armed: the next runner on the same schemas fires it once and keeps the receipts",
      () => {
        const s = schemasOf("restart");
        const host = () => hosted(singleRunner(s).pipe(Layer.provideMerge(pool(s))));
        return Effect.gen(function* () {
          yield* Layer.build(clean(s).pipe(Layer.provide(pool(s))));
          const first = yield* Effect.gen(function* () {
            const holds = yield* Hold;
            const counters = yield* Counter;
            yield* holds.schedule("h-1", new ExpireHold(), {
              after: "1500 millis",
              commandId: "expire",
            });
            return yield* counters.send("c-1", new Increment({ by: 3 }), { commandId: "three" });
            // The runner stops before the timer is due.
          }).pipe(Effect.scoped, Effect.provide(host()));
          yield* Effect.gen(function* () {
            const holds = yield* Hold;
            const counters = yield* Counter;
            const api = yield* ContractApi.Client;
            // The same command id: the stored receipt, not a second commit.
            const again = yield* counters.send("c-1", new Increment({ by: 3 }), {
              commandId: "three",
            });
            expect(again).toEqual(first);
            expect(yield* counters.get("c-1")).toEqual({ total: 3 });
            expect(
              yield* api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version: 1 } }),
            ).toEqual({ total: 3 });
            yield* eventually(
              holds.get("h-1").pipe(
                Effect.filterOrFail(
                  (state) => state.status === "expired",
                  () => "not yet" as const,
                ),
              ),
            );
            // Give a second Fire time to land; the timer still ran once.
            yield* Effect.sleep("1 second");
            expect((yield* holds.get("h-1")).expiries).toBe(1);
          }).pipe(Effect.scoped, Effect.provide(host()));
        }).pipe(Effect.scoped);
      },
      { timeout: 60_000 },
    );

    it.live(
      "two runners from a cold start: the deploy step runs twice at once, each runner holds its shards as advisory locks, and one takes over when the other stops",
      () => {
        const s = schemasOf("runners");
        return Effect.gen(function* () {
          yield* Layer.build(clean(s).pipe(Layer.provide(pool(s))));
          // Two deploy steps at once on empty schemas: both finish, the tables exist once.
          yield* Effect.all(
            [
              Layer.build(migrate(s).pipe(Layer.provide(pool(s)))),
              Layer.build(migrate(s).pipe(Layer.provide(pool(s)))),
            ],
            { concurrency: 2 },
          );
          const sql = yield* SqlClient.SqlClient;
          expect((yield* tablesIn(s.host)).length).toBe(12);

          const start = (port: number, app: string) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              // Stopped before the schemas are dropped, even when the test fails.
              yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
              const context = yield* Layer.buildWithScope(
                hosted(socketRunner(s, port).pipe(Layer.provideMerge(pool(s, app)))),
                scope,
              );
              return { scope, context };
            });
          /** Advisory locks granted to the sessions of one runner's pool. */
          const advisory = (app: string) =>
            sql<{
              n: number | string;
            }>`SELECT COUNT(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.granted AND a.application_name = ${app}`.pipe(
              Effect.map((rows) => Number(rows[0]!.n)),
            );
          const a = yield* start(34441, "dct_pgs_runner_a");
          const b = yield* start(34442, "dct_pgs_runner_b");
          const ids = Array.from({ length: 20 }, (_, i) => `r-${i}`);
          const sendAll = (runner: typeof a, round: number) =>
            Effect.forEach(
              ids,
              (id) =>
                Effect.gen(function* () {
                  const counters = yield* Counter;
                  yield* counters.send(id, new Increment({ by: 1 }), {
                    commandId: `${id}-${round}`,
                  });
                }).pipe(Effect.provide(runner.context)),
              { concurrency: "unbounded", discard: true },
            );
          yield* sendAll(a, 1);
          // Both runners hold shards, each as advisory locks of its own sessions.
          const held = yield* eventually(
            Effect.all([advisory("dct_pgs_runner_a"), advisory("dct_pgs_runner_b")]).pipe(
              Effect.filterOrFail(
                ([onA, onB]) => onA > 0 && onB > 0,
                () => "not yet" as const,
              ),
            ),
            30,
          );
          yield* sendAll(b, 2);

          // B stops; its locks go, A takes its shards and its work.
          yield* Scope.close(b.scope, Exit.void);
          yield* eventually(
            advisory("dct_pgs_runner_b").pipe(
              Effect.filterOrFail(
                (n) => n === 0,
                () => "not yet" as const,
              ),
            ),
            30,
          );
          yield* sendAll(a, 3);
          yield* eventually(
            advisory("dct_pgs_runner_a").pipe(
              Effect.filterOrFail(
                (n) => n > held[0],
                () => "not yet" as const,
              ),
            ),
            60,
          );
          yield* Effect.gen(function* () {
            const counters = yield* Counter;
            const api = yield* ContractApi.Client;
            for (const id of ids) {
              expect(yield* counters.get(id)).toEqual({ total: 3 });
              yield* eventually(
                api.Totals.get(id).pipe(
                  Effect.filterOrFail(
                    (view) => view?.total === 3,
                    () => "not yet" as const,
                  ),
                ),
                60,
              );
            }
          }).pipe(Effect.provide(a.context));
        }).pipe(Effect.scoped, Effect.provide(pool(s)));
      },
      { timeout: 120_000 },
    );
  },
);
