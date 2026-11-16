#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright';

const VERSION = '0.1.0';
const SECRET = /(?:token|secret|password|passwd|api[-_]?key|authorization|session|signature|credential|access[-_]?key|auth|jwt|code)/i;
const STORE = resolve(process.env.PRINCEPO_HOME || `${homedir()}/.princepo`, 'operations.json');
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const cleanName = value => {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Имя должно начинаться с буквы и содержать только a-z, цифры, дефис и подчёркивание.');
  return value;
};

function parseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Нужен адрес HTTP(S) без учётных данных.');
  return url;
}
function safeEndpoint(value) {
  const url = parseUrl(value);
  if ([...url.searchParams.keys()].some(key => SECRET.test(key))) return null;
  url.hash = '';
  return url.href;
}
async function readOperations() {
  try {
    const data = JSON.parse(await readFile(STORE, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Неверный формат файла операций.');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function saveOperation(name, address) {
  cleanName(name);
  const url = safeEndpoint(address);
  if (!url) throw new Error('Адрес содержит параметр, похожий на секрет.');
  const operations = await readOperations();
  if (operations.some(item => item.name === name)) throw new Error('Операция с таким именем уже есть.');
  operations.push({ name, url });
  await mkdir(dirname(STORE), { recursive: true, mode: 0o700 });
  const temp = `${STORE}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(operations, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, STORE);
  return { name, url };
}
async function inspect(address, waitMs = 3000) {
  const start = parseUrl(address);
  if ([...start.searchParams.keys()].some(key => SECRET.test(key))) throw new Error('Не передавайте ключи и токены в адресе.');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
  const page = await context.newPage();
  const endpoints = new Map();
  page.on('response', response => {
    const request = response.request();
    if (request.method() !== 'GET' || !['xhr', 'fetch'].includes(request.resourceType())) return;
    const endpoint = safeEndpoint(response.url());
    if (!endpoint || endpoints.size >= 100) return;
    const type = response.headers()['content-type'] || '';
    endpoints.set(endpoint, { url: endpoint, status: response.status(), contentType: type.split(';')[0] });
  });
  try {
    await page.goto(start.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(waitMs);
    return { page: page.url(), title: await page.title(), endpoints: [...endpoints.values()] };
  } finally {
    await context.close();
    await browser.close();
  }
}
async function callOperation(name) {
  cleanName(name);
  const entry = (await readOperations()).find(item => item.name === name);
  if (!entry) throw new Error('Операция не найдена.');
  if (!safeEndpoint(entry.url)) throw new Error('Небезопасный адрес в файле операции.');
  const response = await fetch(entry.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' } });
  const type = response.headers.get('content-type') || '';
  const length = Number(response.headers.get('content-length'));
  if (length > 1_000_000) throw new Error('Ответ больше 1 МБ.');
  let data = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body ?? []) {
    data += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(data) > 1_000_000) throw new Error('Ответ больше 1 МБ.');
  }
  data += decoder.decode();
  let body = data;
  if (type.includes('json')) { try { body = JSON.parse(data); } catch {} }
  return { status: response.status, contentType: type, body };
}
function createServer() {
  const server = new McpServer({ name: 'princepo', version: VERSION });
  const wrap = fn => async args => {
    try { return text(await fn(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  server.registerTool('inspect_site', {
    description: 'Открыть публичную страницу в браузере и найти её GET-запросы fetch/XHR.',
    inputSchema: { url: z.string().url(), wait_ms: z.number().int().min(0).max(15000).optional() },
  }, wrap(({ url, wait_ms }) => inspect(url, wait_ms)));
  server.registerTool('save_operation', {
    description: 'Сохранить найденный публичный GET-адрес под коротким именем.',
    inputSchema: { name: z.string(), url: z.string().url() },
  }, wrap(({ name, url }) => saveOperation(name, url)));
  server.registerTool('list_operations', { description: 'Показать сохранённые операции.', inputSchema: {} }, wrap(() => readOperations()));
  server.registerTool('call_operation', {
    description: 'Выполнить ранее сохранённый публичный GET-запрос.', inputSchema: { name: z.string() },
  }, wrap(({ name }) => callOperation(name)));
  return server;
}
async function main() {
  const [command = 'serve', ...args] = process.argv.slice(2);
  if (command === 'serve') return createServer().connect(new StdioServerTransport());
  if (command === 'inspect' && args[0]) return console.log(JSON.stringify(await inspect(args[0]), null, 2));
  if (command === 'list') return console.log(JSON.stringify(await readOperations(), null, 2));
  if (command === 'save' && args.length === 2) return console.log(JSON.stringify(await saveOperation(args[0], args[1]), null, 2));
  if (command === 'call' && args[0]) return console.log(JSON.stringify(await callOperation(args[0]), null, 2));
  console.error('Использование: princepo [serve | inspect URL | save ИМЯ URL | list | call ИМЯ]');
  process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
export { safeEndpoint, inspect, saveOperation, readOperations, callOperation, createServer };
