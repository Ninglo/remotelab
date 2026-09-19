#!/usr/bin/env node
import assert from "assert/strict";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(join(repoRoot, ...parts), "utf8");
const template = read("templates", "chat.html");
const sidebarCss = read("static", "chat", "chat-sidebar.css");
const responsiveCss = read("static", "chat", "chat-responsive.css");
const messagesCss = read("static", "chat", "chat-messages.css");
const compose = read("static", "chat", "compose.js");
const sidebarUi = read("static", "chat", "sidebar-ui.js");

assert.match(template, /<body[^>]*data-app-view="sessions"/, "the application shell should start in the Sessions workspace");
assert.match(template, /<nav class="app-rail"[^>]*>[\s\S]*<\/nav>/, "the owner surface needs one global navigation rail");

const railMarkup = template.match(/<nav class="app-rail"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || "";
for (const id of ["tabSessions", "tabAgents", "tabTasks", "tabSettings"]) {
  assert.match(railMarkup, new RegExp(`id="${id}"`), `${id} should be a global application destination`);
}
assert.doesNotMatch(railMarkup, /<a\b/, "workspace switching should use in-page controls rather than page links");

const sidebarStart = template.indexOf('<aside class="sidebar" id="sidebar">');
const sidebarEnd = template.indexOf("</aside>", sidebarStart);
const sessionSidebarMarkup = template.slice(sidebarStart, sidebarEnd);
assert.match(sessionSidebarMarkup, /id="sessionList"/, "the contextual sidebar should contain the Session list");
assert.doesNotMatch(sessionSidebarMarkup, /id="(?:agentsPanel|taskCenterPanel|settingsPanel)"/, "application workspaces must not be squeezed into the Session sidebar");

const workspaceStart = template.indexOf('<div class="app-workspace">');
const chatStart = template.indexOf('id="sessionWorkspace"', workspaceStart);
for (const id of ["agentsPanel", "taskCenterPanel", "settingsPanel"]) {
  const panelPosition = template.indexOf(`id="${id}"`, workspaceStart);
  assert.ok(panelPosition > workspaceStart && panelPosition < chatStart, `${id} should share the main application workspace`);
}

assert.match(sidebarCss, /\.app-rail\s*\{[\s\S]*?flex-direction:\s*column;/, "desktop destinations should form one compact vertical button column");
assert.match(responsiveCss, /body:not\(\[data-app-view="sessions"\]\) \.sidebar-overlay\s*\{[\s\S]*?width:\s*var\(--app-rail-width\);/, "non-Session workspaces should collapse the desktop chrome to the rail");
assert.match(messagesCss, /\.chat-area\[hidden\]\s*\{\s*display:\s*none;/, "the Session workspace should be hidden in-place");
assert.match(compose, /renderHeaderWorkspaceTitle\(activeTab\)/, "workspace switching should update shared application chrome");
assert.match(compose, /resolvedSessionWorkspace\.hidden = !showingSessions/, "workspace switching should toggle components in the same document");
assert.match(sidebarUi, /function openApplicationNavigation\(\)[\s\S]*?openSidebar\(\)/, "mobile navigation should open without forcing a workspace change");
assert.doesNotMatch(compose, /location\.(?:assign|replace|href)\s*=/, "workspace switches should not perform page navigation");

console.log("Application rail and single-page workspace contract tests passed.");
