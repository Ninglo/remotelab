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
const bootstrap = read("static", "chat", "bootstrap.js");
const tooling = read("static", "chat", "tooling.js");
const settingsUi = read("static", "chat", "settings-ui.js");

assert.match(template, /<body[^>]*data-app-view="sessions"/, "the application shell should start in the Sessions workspace");
assert.doesNotMatch(template, /class="app-rail"|class="navigation-drawer"/, "the application must not add a second navigation column");
assert.doesNotMatch(template, /id="(?:tabAgents|agentsPanel|tabSessions)"/, "the redundant Agent and Sessions destinations should be removed");
assert.doesNotMatch(template, /class="sidebar-header"/, "the sidebar should not repeat the product name");
assert.doesNotMatch(template, /id="sessionListFooter"|data-i18n-build-label/, "build metadata should not occupy sidebar space");
assert.doesNotMatch(template, /id="inlineAgentSelect"/, "the composer should not expose an Agent picker");
assert.match(template, /class="header-quick-actions"[\s\S]*id="headerNewSessionBtn"[\s\S]*id="headerTasksBtn"/, "mobile chrome should keep New Session and Tasks one tap away");

const sidebarStart = template.indexOf('<aside class="sidebar" id="sidebar">');
const sidebarEnd = template.indexOf("</aside>", sidebarStart);
const sessionSidebarMarkup = template.slice(sidebarStart, sidebarEnd);
for (const id of ["newSessionBtn", "tabTasks", "sessionList", "tabSettings"]) {
  assert.match(sessionSidebarMarkup, new RegExp(`id="${id}"`), `${id} should live in the single Session sidebar`);
}
assert.ok(
  sessionSidebarMarkup.indexOf('id="tabTasks"') < sessionSidebarMarkup.indexOf('id="sourceFilterSelect"')
    && sessionSidebarMarkup.indexOf('id="sourceFilterSelect"') < sessionSidebarMarkup.indexOf('id="sessionList"')
    && sessionSidebarMarkup.indexOf('id="sessionList"') < sessionSidebarMarkup.indexOf('id="newSessionBtn"')
    && sessionSidebarMarkup.indexOf('id="newSessionBtn"') < sessionSidebarMarkup.indexOf('id="tabSettings"'),
  "the sidebar should keep Tasks at the top and place New Session beside Settings in the reachable bottom zone",
);
assert.doesNotMatch(sessionSidebarMarkup, /<a\b/, "workspace switching should use in-page controls rather than page links");
assert.doesNotMatch(sessionSidebarMarkup, /id="(?:agentsPanel|taskCenterPanel|settingsPanel)"/, "application workspaces must remain in the main pane");

const workspaceStart = template.indexOf('<div class="app-workspace">');
const chatStart = template.indexOf('id="sessionWorkspace"', workspaceStart);
for (const id of ["taskCenterPanel", "settingsPanel"]) {
  const panelPosition = template.indexOf(`id="${id}"`, workspaceStart);
  assert.ok(panelPosition > workspaceStart && panelPosition < chatStart, `${id} should share the main application workspace`);
}

assert.match(sidebarCss, /\.sidebar-nav-button\s*\{[\s\S]*?display:\s*flex;/, "application destinations should look like classic full-width sidebar rows");
assert.match(responsiveCss, /\.sidebar-overlay\s*\{[\s\S]*?width:\s*var\(--sidebar-width\);/, "the single desktop sidebar should remain visible for every workspace");
assert.doesNotMatch(responsiveCss, /body:not\(\[data-app-view="sessions"\]\) \.sidebar/, "control workspaces must not replace the sidebar with another rail");
assert.match(messagesCss, /\.chat-area\[hidden\]\s*\{\s*display:\s*none;/, "the Session workspace should be hidden in-place");
assert.match(compose, /renderHeaderWorkspaceTitle\(activeTab\)/, "workspace switching should update shared application chrome");
assert.match(compose, /resolvedSessionWorkspace\.hidden = !showingSessions/, "workspace switching should toggle components in the same document");
assert.match(sidebarUi, /function openApplicationNavigation\(\)[\s\S]*?openSidebar\(\)/, "mobile navigation should open without forcing a workspace change");
assert.doesNotMatch(compose, /location\.(?:assign|replace|href)\s*=/, "workspace switches should not perform page navigation");
assert.doesNotMatch(tooling, /\/api\/agents|inlineAgentSelect/, "owner tooling should not load or render Agent choices");
assert.doesNotMatch(bootstrap, /function (?:set|get)PreferredAgentTemplate/, "the owner shell should not keep Agent preference state");

for (const sectionId of ["settings-general", "settings-sessions", "settings-people", "settings-connections", "settings-device"]) {
  assert.match(template, new RegExp(`data-settings-target="${sectionId}"`), `${sectionId} should be linked from the Settings directory`);
  assert.match(template, new RegExp(`id="${sectionId}"[^>]*data-settings-section`), `${sectionId} should identify a Settings content group`);
}
assert.match(sidebarCss, /\.settings-layout\s*\{[\s\S]*grid-template-columns:\s*176px minmax\(0, 960px\)/, "desktop Settings should use a stable directory and content layout");
assert.match(sidebarCss, /\.settings-page-header\s*\{[\s\S]*grid-column:\s*2/, "the Settings title should align with the content column");
assert.match(responsiveCss, /@media \(max-width:\s*767px\)[\s\S]*\.settings-toc\s*\{[\s\S]*overflow-x:\s*auto/, "mobile Settings should turn the directory into a horizontal sticky list");
assert.match(settingsUi, /target\.scrollIntoView\(\{ behavior:/, "Settings directory links should jump within the page");
assert.match(settingsUi, /settingsPanel\.addEventListener\("scroll"/, "Settings directory should track the visible section");
assert.match(sidebarUi, /event\.metaKey \|\| event\.ctrlKey[\s\S]*event\.shiftKey[\s\S]*event\.key === "Enter"/, "New Session should expose a cross-platform keyboard shortcut");

console.log("Classic sidebar and single-page workspace contract tests passed.");
