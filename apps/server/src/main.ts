import { serve } from '@hono/node-server';
import { createApi } from './api.ts';
import { createDiscordNotifier, startBot } from './bot.ts';
import { loadConfig } from './config.ts';
import { createServices } from './services.ts';

const config = await loadConfig();
const apiBase = `http://127.0.0.1:${config.port}`;

const services = createServices(config, { notifier: createDiscordNotifier(config) });
const app = createApi(services);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[disdk] api listening on http://localhost:${info.port}`);
  console.log(`[disdk] cluster ${config.cluster}, mint ${config.mint}`);
  console.log(`[disdk] sponsor (fee payer) ${config.sponsor.address}`);
  console.log(`[disdk] delegate (spender)  ${config.delegate}`);
  console.log(`[disdk] allowance policy: ${config.allowanceDescription}`);
});

await startBot({ config, apiBase });
