import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import ponytailExtension from "../index.js";
const aliasCommands = ["ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"];

function readRootPackageJson() {
  return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
}

function createPiHarness() {
  const events = new Map();
  const commands = new Map();
  const appendedEntries = [];
  const sentUserMessages = [];

  const pi = {
    on(eventName, handler) {
      events.set(eventName, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    sendUserMessage(text, options) {
      sentUserMessages.push({ text, options });
    },
  };

  ponytailExtension(pi);
  return { events, commands, appendedEntries, sentUserMessages };
}

function createCommandContext(overrides = {}) {
  return {
    isIdle: () => true,
    sessionManager: { getEntries: () => [] },
    ui: { notify() {} },
    ...overrides,
  };
}

function withTempConfig(fn) {
  const tempConfigHome = mkdtempSync(join(tmpdir(), "ponytail-test-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempConfigHome;

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(tempConfigHome, { recursive: true, force: true });
    });
}

test("extension registers Ponytail commands", () => {
  const { commands } = createPiHarness();

  assert.deepEqual([...commands.keys()].sort(), ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"]);
});

test("package manifest exposes OMP-compatible extension entry points", async () => {
  const manifest = readRootPackageJson();

  assert.deepEqual(manifest.omp, manifest.pi);
  assert.ok(Array.isArray(manifest.omp.extensions));
  assert.ok(manifest.omp.extensions.length > 0);

  for (const extensionPath of manifest.omp.extensions) {
    assert.equal(typeof extensionPath, "string");
    const extensionUrl = new URL(`../../${extensionPath}`, import.meta.url);
    assert.equal(existsSync(extensionUrl), true, `${extensionPath} must exist`);

    const extensionModule = await import(extensionUrl.href);
    assert.equal(typeof extensionModule.default, "function", `${extensionPath} must default-export an extension function`);
  }
});

test("/ponytail updates session mode and injects instructions", async () => withTempConfig(async () => {
  const { commands, events, appendedEntries } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ponytail").handler("ultra", ctx);

  assert.deepEqual(appendedEntries.at(-1), {
    customType: "ponytail-mode",
    data: { mode: "ultra" },
  });

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.ok(result.systemPrompt.includes("PONYTAIL MODE ACTIVE"));
  assert.ok(result.systemPrompt.includes("ultra"));
}));

test("session_start restores latest persisted mode", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const ctx = createCommandContext({
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: "ponytail-mode", data: { mode: "full" } },
        { type: "custom", customType: "ponytail-mode", data: { mode: "lite" } },
      ],
    },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);

  assert.ok(result.systemPrompt.includes("lite"));
}));

test("skill alias commands preserve trailing args when delegating to Pi skills", async () => {
  const { commands, sentUserMessages } = createPiHarness();
  const ctx = createCommandContext();
  const args = "src/app.js --since main";

  for (const commandName of aliasCommands) {
    await commands.get(commandName).handler(args, ctx);
  }

  assert.deepEqual(sentUserMessages, aliasCommands.map((commandName) => ({
    text: `/skill:${commandName} ${args}`,
    options: undefined,
  })));
});

test("skill alias commands queue follow-ups with args when context is busy", async () => {
  const { commands, sentUserMessages } = createPiHarness();
  const ctx = createCommandContext({ isIdle: () => false });
  const args = "src/app.js --since main";

  for (const commandName of aliasCommands) {
    await commands.get(commandName).handler(args, ctx);
  }

  assert.deepEqual(sentUserMessages, aliasCommands.map((commandName) => ({
    text: `/skill:${commandName} ${args}`,
    options: { deliverAs: "followUp" },
  })));
});

test("/ponytail off disables persistent instructions", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ponytail").handler("ultra", ctx);
  await commands.get("ponytail").handler("off", ctx);

  const disabled = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.equal(disabled, undefined);
}));

test("normal mode disables persistent instructions", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ponytail").handler("ultra", ctx);
  await events.get("input")({ text: "normal mode", source: "interactive" }, ctx);

  const disabled = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.equal(disabled, undefined);
}));

test("a request mentioning normal mode stays active", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ponytail").handler("ultra", ctx);
  await events.get("input")({ text: "add a normal mode toggle next to dark mode", source: "interactive" }, ctx);

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.match(result.systemPrompt, /PONYTAIL MODE ACTIVE/);
}));

test("status bar renders the mode and flips active on agent_start", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (key, text) => statusWrites.push({ key, text }), theme: { fg: (color, text) => `<${color}>${text}</${color}>` } },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  await events.get("agent_start")({}, ctx);

  assert.equal(statusWrites.at(-2).key, "ponytail");
  assert.match(statusWrites.at(-2).text, /<dim>○<\/dim>.*<text>🔥 ULTRA<\/text>/);
  assert.match(statusWrites.at(-1).text, /<accent>●<\/accent>.*<text>🔥 ULTRA<\/text>/);
}));

test("status bar no-ops when ui or theme integration is unavailable", async () => withTempConfig(async () => {
  const statusWrites = [];
  const sessionManager = { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] };

  for (const ctx of [
    createCommandContext({ sessionManager, ui: undefined }),
    createCommandContext({
      sessionManager,
      ui: { notify() {}, setStatus: (_key, text) => statusWrites.push(text) },
    }),
  ]) {
    const { events } = createPiHarness();
    await events.get("session_start")({ reason: "resume" }, ctx);
    await events.get("agent_start")({}, ctx);
  }

  assert.deepEqual(statusWrites, []);
}));
