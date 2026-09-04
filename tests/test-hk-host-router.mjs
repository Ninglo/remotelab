#!/usr/bin/env node
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function createTextServer(body) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Number(server.address()?.port || 0);
}

async function reservePort() {
  const server = http.createServer((req, res) => res.end('reserved'));
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: {
        host,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ownerServer = createTextServer('owner');
const guestServer = createTextServer('guest');
const exposedServer = createTextServer('exposed');
const sandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-hk-host-router-'));
let router = null;

try {
  const ownerPort = await listen(ownerServer);
  const guestPort = await listen(guestServer);
  const exposedPort = await listen(exposedServer);
  const routerPort = await reservePort();

  const configDir = join(sandboxHome, '.config', 'remotelab');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'guest-instances.json'), JSON.stringify([
    {
      name: 'trial24',
      port: guestPort,
      hostname: 'trial24.example.com',
    },
  ], null, 2));
  writeFileSync(join(configDir, 'guest-instance-routes.json'), JSON.stringify([
    {
      instanceName: 'trial24',
      label: 'report',
      port: exposedPort,
      hostname: 'trial24-report.example.com',
      targetHost: '127.0.0.1',
    },
  ], null, 2));

  router = spawn('node', ['scripts/hk-host-router.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: sandboxHome,
      HK_HOST_ROUTER_LISTEN_PORT: String(routerPort),
      HK_HOST_ROUTER_OWNER_PORT: String(ownerPort),
      HK_HOST_ROUTER_HUB_PORT: String(ownerPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('host router did not start in time')), 10000);
    router.stdout.on('data', (chunk) => {
      if (String(chunk).includes('hk host router listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    router.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    router.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`host router exited early (${code ?? 'null'} / ${signal ?? 'null'})`));
    });
  });

  const guestResponse = await request(routerPort, 'trial24.example.com');
  assert.equal(guestResponse.statusCode, 200);
  assert.equal(guestResponse.body, 'guest');

  const exposedResponse = await request(routerPort, 'trial24-report.example.com');
  assert.equal(exposedResponse.statusCode, 200);
  assert.equal(exposedResponse.body, 'exposed');

  const ownerResponse = await request(routerPort, 'unknown.example.com');
  assert.equal(ownerResponse.statusCode, 200);
  assert.equal(ownerResponse.body, 'owner');
} finally {
  if (router) {
    if (router.exitCode === null && router.signalCode === null) {
      router.kill('SIGTERM');
      await new Promise((resolve) => router.once('exit', resolve));
    }
  }
  await new Promise((resolve) => exposedServer.close(resolve));
  await new Promise((resolve) => guestServer.close(resolve));
  await new Promise((resolve) => ownerServer.close(resolve));
  rmSync(sandboxHome, { recursive: true, force: true });
}

console.log('test-hk-host-router: ok');
