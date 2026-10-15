import { gateway } from '../hosting/gateway.mjs';

export default { fetch: request => gateway(request, process.env) };
