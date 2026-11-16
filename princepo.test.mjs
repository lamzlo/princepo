import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP: поиск запроса, сохранение и чтение результата', async () => {
  let writes = 0;
  const fixture = createServer((req, res) => {
    if (req.method === 'POST') { writes++; res.end('bad'); return; }
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Привет', items: [1, 2] }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Тестовый сайт</title><script>fetch("/api/items?limit=2"); fetch("/api/change", {method:"POST"}).catch(()=>{});</script>');
    }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(join(tmpdir(), 'princepo-test-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'princepo.mjs'), 'serve'], env: { ...process.env, PRINCEPO_HOME: home } });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const address = `http://127.0.0.1:${fixture.address().port}`;
  try {
    await client.connect(transport);
    const available = await client.listTools();
    assert.deepEqual(available.tools.map(x => x.name).sort(), ['call_operation', 'inspect_site', 'list_operations', 'save_operation']);
    const result = await client.callTool({ name: 'inspect_site', arguments: { url: address, wait_ms: 300 } });
    assert.equal(result.isError, undefined);
    const page = JSON.parse(result.content[0].text);
    assert.equal(page.title, 'Тестовый сайт');
    assert.equal(page.endpoints.length, 1);
    assert.equal(writes, 0);
    const save = await client.callTool({ name: 'save_operation', arguments: { name: 'items', url: page.endpoints[0].url } });
    assert.equal(save.isError, undefined);
    const call = await client.callTool({ name: 'call_operation', arguments: { name: 'items' } });
    assert.deepEqual(JSON.parse(call.content[0].text).body, { message: 'Привет', items: [1, 2] });
    const unsafe = await client.callTool({ name: 'save_operation', arguments: { name: 'secret', url: `${address}/api?token=abc` } });
    assert.equal(unsafe.isError, true);
  } finally {
    await client.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    await unlink(join(home, 'operations.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(home);
  }
});
