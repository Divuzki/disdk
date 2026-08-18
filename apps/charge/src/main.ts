import { serve } from '@hono/node-server';
import { describeTerms } from '@disdk/verify';
import { createApi } from './api.ts';
import { loadConfig } from './config.ts';
import { createServices } from './services.ts';

const config = await loadConfig();
const services = createServices(config);
const app = createApi(services);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[disdk] charge service on http://localhost:${info.port}`);
  console.log(`[disdk] cluster ${config.cluster}, mint ${config.mint}`);
  console.log(`[disdk] delegate (spender) ${config.delegate.address}`);
  console.log(`[disdk] treasury (settles to) ${config.terms.treasury}`);
  console.log(`[disdk] terms: ${describeTerms(config.terms, config.mintSymbol, config.decimals)}`);
});
