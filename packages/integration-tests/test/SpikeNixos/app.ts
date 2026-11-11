/** Tiny app: GET /place/:id, /order/:id, /stock/:id, /version. Runs as a bun process (Docker.Service shape). */
import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SpikeLive } from "./live.ts";
import { Order, PlaceOrder, Stock } from "./model.ts";

export default class SpikeApp extends Docker.Service<SpikeApp>()(
  "SpikeApp",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const orders = yield* Order;
    const stock = yield* Stock;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://app");
        const [, action, raw] = url.pathname.split("/");
        const id = decodeURIComponent(raw ?? "");
        switch (action) {
          case "version":
            return yield* HttpServerResponse.json({ version: process.env.SPIKE_VERSION ?? "?" });
          case "place":
            yield* orders.send(id, new PlaceOrder(), { commandId: `place-${id}` });
            return yield* HttpServerResponse.json(yield* orders.get(id));
          case "order":
            return yield* HttpServerResponse.json(yield* orders.get(id));
          case "stock":
            return yield* HttpServerResponse.json(yield* stock.get(id));
          default:
            return HttpServerResponse.text("Not Found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(SpikeLive)),
) {}
