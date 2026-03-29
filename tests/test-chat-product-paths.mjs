#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static/chat/product-paths.js'), 'utf8');

function createContext({ href, pathname, baseHref = '' }) {
  const location = {
    href,
    pathname,
    origin: new URL(href).origin,
  };
  const context = {
    console,
    URL,
    location,
    window: null,
    document: {
      querySelector(selector) {
        if (selector !== 'base[href]' || !baseHref) return null;
        return {
          getAttribute(name) {
            return name === 'href' ? baseHref : null;
          },
        };
      },
    },
  };
  context.window = context;
  context.globalThis = context;
  context.self = context;
  return context;
}

function loadHelpers(context) {
  vm.runInNewContext(source, context, { filename: 'static/chat/product-paths.js' });
  return {
    getBasePath: context.remotelabGetProductBasePath,
    getBaseUrl: context.remotelabGetProductBaseUrl,
    resolvePath: context.remotelabResolveProductPath,
    resolveUrl: context.remotelabResolveProductUrl,
  };
}

const rootContext = createContext({
  href: 'https://chat.example.com/',
  pathname: '/',
});
const rootHelpers = loadHelpers(rootContext);
assert.equal(rootHelpers.getBasePath(), '/', 'root product should resolve to root base path');
assert.equal(rootHelpers.resolvePath('/api/auth/me'), '/api/auth/me', 'root product paths should stay at origin root');
assert.equal(rootHelpers.resolvePath('/?skipInstall=1'), '/?skipInstall=1', 'root continue-in-browser path should stay at origin root');

const prefixedRootContext = createContext({
  href: 'https://chat.example.com/trial16/?token=demo',
  pathname: '/trial16/',
});
const prefixedRootHelpers = loadHelpers(prefixedRootContext);
assert.equal(prefixedRootHelpers.getBasePath(), '/trial16', 'prefixed root should infer its product prefix');
assert.equal(prefixedRootHelpers.getBaseUrl(), 'https://chat.example.com/trial16/', 'prefixed root should keep a directory base URL');
assert.equal(prefixedRootHelpers.resolvePath('/api/auth/me'), '/trial16/api/auth/me', 'prefixed API paths should stay inside the product prefix');
assert.equal(prefixedRootHelpers.resolvePath('/trial16/api/auth/me'), '/trial16/api/auth/me', 'already-prefixed paths should not double-prefix');
assert.equal(prefixedRootHelpers.resolvePath('/?skipInstall=1'), '/trial16/?skipInstall=1', 'prefixed continue-in-browser path should stay inside the product prefix');

const installContext = createContext({
  href: 'https://chat.example.com/m/install?h=demo',
  pathname: '/m/install',
});
const installHelpers = loadHelpers(installContext);
assert.equal(installHelpers.getBasePath(), '/', 'root install route should resolve back to root');
assert.equal(installHelpers.resolvePath('/login'), '/login', 'root install login redirect should stay at root');

const prefixedInstallContext = createContext({
  href: 'https://chat.example.com/trial16/m/install?h=demo',
  pathname: '/trial16/m/install',
  baseHref: '/trial16/',
});
const prefixedInstallHelpers = loadHelpers(prefixedInstallContext);
assert.equal(prefixedInstallHelpers.getBasePath(), '/trial16', 'prefixed install route should resolve back to the product prefix');
assert.equal(prefixedInstallHelpers.resolvePath('/login'), '/trial16/login', 'prefixed install login redirect should stay inside the product prefix');
assert.equal(prefixedInstallHelpers.resolvePath('/m/continue?h=demo'), '/trial16/m/continue?h=demo', 'prefixed install continue bridge should stay inside the product prefix');
assert.equal(prefixedInstallHelpers.resolvePath('/sw.js?v=build123'), '/trial16/sw.js?v=build123', 'prefixed service worker path should stay inside the product prefix');
assert.equal(prefixedInstallHelpers.resolveUrl('/trial16/api/install/handoff/redeem'), 'https://chat.example.com/trial16/api/install/handoff/redeem', 'already-prefixed absolute product URLs should remain stable');

console.log('test-chat-product-paths: ok');
