import { createBridgeServer, DeliveryStore, loadBridgeConfig } from "./bridge.mjs";

const config = loadBridgeConfig();
const deliveries = await DeliveryStore.open(config.dedupeFile);
const server = createBridgeServer({ config, deliveries });

server.listen(config.port, config.host, () => {
  process.stdout.write(`WeCom CLI bridge listening on ${config.host}:${config.port}\n`);
});
