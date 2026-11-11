import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
/** The model on Effect Cluster entities. The pool is never deployed by alchemy here:
 * runners and app run as NixOS systemd units; the pool Layer only matters at deploy time. */
import * as Cluster from "@alchemy.run/effect-cluster";
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";
import { SpikeModel } from "./model.ts";

// At runtime (`__ALCHEMY_RUNTIME__`) the pool Layer reads everything from env; its kind does not matter.
const Database = Cluster.Database.fromUrl({ url: undefined as never });
const Pool = ClusterDocker.SwarmPool("SpikePool").pipe(Layer.provide(Database));

export const SpikeLive = SpikeModel.pipe(
  Layer.provide(
    DomainCluster.layerEntities({
      name: "Spike",
      main: import.meta.url,
      handler: "SpikeLive",
      pool: Pool,
    }),
  ),
);
