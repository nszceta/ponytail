import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  filterSkillBodyForMode,
  parsePonytailCommand,
  readDefaultMode,
  resolveSessionMode,
  writeDefaultMode,
} from "../index.js";

const expectedSkillNames = ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"];

function extractFrontmatter(markdown, skillName) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, `${skillName} must start with YAML frontmatter`);
  return match[1];
}

function frontmatterField(frontmatter, fieldName) {
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match || match[1] !== fieldName) continue;

    const inlineValue = match[2].trim();
    if (inlineValue && inlineValue !== ">" && inlineValue !== "|") {
      return inlineValue.replace(/^['"]|['"]$/g, "");
    }

    const blockLines = [];
    for (let next = index + 1; next < lines.length && /^\s+/.test(lines[next]); next += 1) {
      blockLines.push(lines[next].trim());
    }
    return blockLines.join(" ").trim();
  }

  return "";
}

test("skill layout exposes expected OMP skills with names and descriptions", () => {
  for (const skillName of expectedSkillNames) {
    const skillPath = new URL(`../../skills/${skillName}/SKILL.md`, import.meta.url);
    assert.equal(existsSync(skillPath), true, `${skillName} must provide skills/${skillName}/SKILL.md`);

    const frontmatter = extractFrontmatter(readFileSync(skillPath, "utf8"), skillName);
    assert.equal(frontmatterField(frontmatter, "name"), skillName);
    assert.match(frontmatterField(frontmatter, "description"), /\S/, `${skillName} must describe when to use the skill`);
  }
});

test("parsePonytailCommand falls back to full when invoked bare and default is off", () => {
  assert.deepEqual(parsePonytailCommand("", "off"), { type: "set-mode", mode: "full" });
});

test("parsePonytailCommand parses modes, status, and default subcommand", () => {
  assert.deepEqual(parsePonytailCommand("ultra", "full"), { type: "set-mode", mode: "ultra" });
  assert.deepEqual(parsePonytailCommand("status", "full"), { type: "status" });
  assert.deepEqual(parsePonytailCommand("default lite", "full"), { type: "set-default", mode: "lite" });
});

test("resolveSessionMode prefers latest persisted session mode", () => {
  const entries = [
    { type: "custom", customType: "ponytail-mode", data: { mode: "lite" } },
    { type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } },
  ];

  assert.equal(resolveSessionMode(entries, "full"), "ultra");
});

test("resolveSessionMode returns fallback when entries is not an array", () => {
  assert.equal(resolveSessionMode(null, "ultra"), "ultra");
  assert.equal(resolveSessionMode(undefined, "lite"), "lite");
  assert.equal(resolveSessionMode({}, "full"), "full");
  assert.equal(resolveSessionMode("not an array"), "full"); // DEFAULT_MODE fallback
});

test("readDefaultMode and writeDefaultMode use XDG config path", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ponytail-config-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousDefault = process.env.PONYTAIL_DEFAULT_MODE;
  const configPath = join(tempDir, "ponytail", "config.json");
  process.env.XDG_CONFIG_HOME = tempDir;
  delete process.env.PONYTAIL_DEFAULT_MODE;

  try {
    assert.equal(readDefaultMode(), "full");
    assert.equal(writeDefaultMode("ultra"), "ultra");
    assert.equal(readDefaultMode(), "ultra");
    assert.ok(existsSync(configPath));
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { defaultMode: "ultra" });
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousDefault === undefined) delete process.env.PONYTAIL_DEFAULT_MODE;
    else process.env.PONYTAIL_DEFAULT_MODE = previousDefault;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("filterSkillBodyForMode keeps only requested intensity examples and rows", () => {
  const body = `---\nname: ponytail\n---\n| **lite** | keep lite |\n| **full** | keep full |\n| **ultra** | keep ultra |\n- lite: Lite example\n- full: Full example\n- ultra: Ultra example\nOther line`;

  const filtered = filterSkillBodyForMode(body, "ultra");

  assert.ok(!filtered.includes("keep lite"));
  assert.ok(!filtered.includes("keep full"));
  assert.ok(filtered.includes("keep ultra"));
  assert.ok(!filtered.includes("Lite example"));
  assert.ok(filtered.includes("Ultra example"));
  assert.ok(filtered.includes("Other line"));
});

test("filterSkillBodyForMode keeps rule bullets that contain a colon", () => {
  // Regression: rule bullets outside the Intensity section (e.g. the
  // "No unrequested abstractions:" rule or the `ponytail:` comment convention)
  // contain a colon and must not be mistaken for mode-example lines.
  const skillPath = new URL("../../skills/ponytail/SKILL.md", import.meta.url);
  const body = readFileSync(skillPath, "utf8");

  const filtered = filterSkillBodyForMode(body, "full");

  assert.ok(filtered.includes("No unrequested abstractions"));
  assert.ok(filtered.includes("Mark deliberate simplifications"));
  // The Intensity examples are still filtered down to the active mode.
  assert.ok(filtered.includes('full: "`@lru_cache'));
  assert.ok(!filtered.includes('lite: "Done'));
  assert.ok(!filtered.includes('ultra: "No cache'));
});
