// Optional fault reproduction: run inside the isolated container described in
// http-keepalive.md. Both origins bind loopback; neither loads Den or a DB.
import { serve } from '@hono/node-server';
import { serveDenHttp } from '../../src/http-server.ts';

for (const [port, start] of [[4101, serve], [4102, serveDenHttp]]) {
  start({
    port,
    hostname: '127.0.0.1',
    fetch: async request => {
      await request.text();
      return new Response('ok');
    },
  }, () => console.log(`ready ${port}`));
}
