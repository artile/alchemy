import type { Delivery } from "./Platform.ts";

/**
 * How a view or projection added after its sources recorded events receives
 * their history. Pure rules shared by every platform.
 *
 * Each source instance (an aggregate instance, or a view key that other
 * consumers read) records how far it has routed its events to each view and
 * projection: its `Routed` cursors. A consumer whose cursor is behind the
 * instance's version is lagging. Live deliveries skip it, and the instance
 * replays its stored events to it instead, in order, through the same outbox,
 * until it reaches the current version and rejoins live delivery. So every
 * consumer receives one source instance's events in order, as the live path
 * does, and replays never jump ahead of history.
 *
 * Platforms replay in rounds bounded by the clock (see {@link TICKS}): each
 * round replays every instance's events before `until`, merged by
 * {@link byPosition}, so a consumer fed by many instances sees their history
 * in clock order, with every effect of a policy after its cause. Policies are
 * never caught up: they act on new events only.
 *
 * @internal
 */

/** The last `seq` a source instance routed to each consumer, by {@link targetId}. */
export type Routed = Readonly<Record<string, number>>;

/** A consumer's id in {@link Routed}: `view:Name` or `projection:Name`. */
export const targetId = (target: Delivery["target"]): string => `${target.kind}:${target.name}`;

/**
 * Route a commit's deliveries: drop those to lagging consumers (they receive
 * the events by replay), and advance the cursors of the live ones from
 * `before` to `after`. An instance with no cursors yet predates catch-up; its
 * consumers are taken as caught up.
 */
export const routeLive = (
  targets: ReadonlyArray<string>,
  routed: Routed | undefined,
  before: number,
  after: number,
  deliveries: ReadonlyArray<Delivery>,
): { readonly deliveries: ReadonlyArray<Delivery>; readonly routed: Routed } => {
  const base: Routed = routed ?? Object.fromEntries(targets.map((target) => [target, before]));
  const live = (target: string) => (base[target] ?? 0) === before;
  const next: Record<string, number> = { ...base };
  for (const target of targets) if (live(target)) next[target] = after;
  return {
    deliveries: deliveries.filter(
      (delivery) => delivery.target.kind === "policy" || live(targetId(delivery.target)),
    ),
    routed: next,
  };
};

/**
 * The lowest cursor among consumers behind `version`: replay the instance's
 * rows after it. `undefined` when every consumer is caught up.
 */
export const laggingFrom = (
  targets: ReadonlyArray<string>,
  routed: Routed | undefined,
  version: number,
): number | undefined => {
  if (routed === undefined) return undefined;
  let from: number | undefined;
  for (const target of targets) {
    const cursor = routed[target] ?? 0;
    if (cursor < version) from = from === undefined ? cursor : Math.min(from, cursor);
  }
  return from;
};

/** What a replay needs: stored rows after {@link laggingFrom}, in order. */
export interface ReplayInput<Row> {
  /** The instance: an aggregate id, or a view key. */
  readonly id: string;
  readonly routed: Routed;
  readonly rows: ReadonlyArray<Row>;
  /** Replay only rows whose clock is before this, in milliseconds (`clock / TICKS`). */
  readonly until: number;
}

/** What a replay produced. */
export interface ReplayResult {
  /** Deliveries to lagging consumers, marked `history`. */
  readonly deliveries: ReadonlyArray<Delivery>;
  readonly routed: Routed;
  /** The clock of the first row left unreplayed, in milliseconds, if a row was left. */
  readonly next: number | undefined;
}

/** The earlier of two optional times. */
export const earliest = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/**
 * Ticks of the hybrid logical clock per millisecond. An event's `clock` is
 * `now * TICKS` unless its cause (the event whose policy sent the command) or
 * the instance's previous event already has a clock at or past that: then it
 * is one tick after the larger of them. So a clock never runs backwards on an
 * instance, every command a policy sends commits after the event it reacted
 * to, and the clock stays close to wall time unless a host's clock runs ahead.
 * A view entry is a new event on its key: its clock is its input's clock, or
 * one tick after the key's previous entry if that is later.
 */
export const TICKS = 1000;

/** The clock of the first event of a commit: see {@link TICKS}. */
export const stamp = (now: number, after: number | undefined): number =>
  after === undefined ? now * TICKS : Math.max(now * TICKS, after + 1);

/** An event's place in the cross-aggregate order: its clock, else its commit time. */
export const positionOf = (envelope: { readonly at: number; readonly clock?: number }): number =>
  envelope.clock ?? envelope.at * TICKS;

/**
 * Which of two replayed deliveries comes first: by clock, then by source
 * stream and `seq`. Every source's clocks rise with `seq`, so it keeps each
 * source's order, puts a policy's effects after their causes, and does not
 * depend on how instances were listed.
 */
export const byPosition = (a: Delivery, b: Delivery): number =>
  positionOf(a.envelope) - positionOf(b.envelope) ||
  (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
  a.seq - b.seq;

/**
 * Merge each source's items, kept in their own order, into one: take the
 * source whose next item comes first by {@link byPosition}. Entries a view
 * stored before clocks carry their inputs' `at`, which need not rise with
 * `seq`, so a plain sort could reorder one source.
 */
export const mergeBySource = <T>(
  items: ReadonlyArray<T>,
  deliveryOf: (item: T) => Delivery,
): Array<T> => {
  const queues = new Map<string, Array<T>>();
  for (const item of items) {
    const source = deliveryOf(item).source;
    const queue = queues.get(source);
    if (queue) queue.push(item);
    else queues.set(source, [item]);
  }
  const heads = [...queues.values()];
  const out: Array<T> = [];
  while (heads.length > 0) {
    let first = 0;
    for (let i = 1; i < heads.length; i++)
      if (byPosition(deliveryOf(heads[i]![0]!), deliveryOf(heads[first]![0]!)) < 0) first = i;
    out.push(heads[first]!.shift()!);
    if (heads[first]!.length === 0) heads.splice(first, 1);
  }
  return out;
};
