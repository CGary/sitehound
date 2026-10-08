/** profile commands against a synthetic profile written into an isolated HOUND_HOME (never real credentials). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeEnv, startFixture, writeSyntheticProfile, type Env, type Fixture } from "./helpers/hound.ts";

describe("profile commands", () => {
  let env: Env;
  let fx: Fixture;
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
  });
  after(async () => {
    await fx.close();
    await env.cleanup();
  });

  it("list is empty on a fresh home", async () => {
    const r = await env.hound(["profile", "list"]);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.json.data, { count: 0, profiles: [] });
    assert.match(r.json.next_actions[0].command, /profile login/);
  });

  it("delete without --yes/--dry-run: CONFIRMATION_REQUIRED (exit 2) with both alternatives", async () => {
    const r = await env.hound(["profile", "delete", "--profile", "ghost"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "CONFIRMATION_REQUIRED");
    assert.match(r.json.suggested_fix.command, /--dry-run/);
    assert.equal(r.json.data.alternatives.length, 2);
    const both = await env.hound(["profile", "delete", "--profile", "ghost", "--yes", "--dry-run"]);
    assert.equal(both.exitCode, 2);
    assert.equal(both.json.error.code, "INVALID_ARGUMENT");
  });

  it("login needs a human: NO_TTY, exit 1, nothing created", async () => {
    const r = await env.hound(["profile", "login", "--profile", "work", "--url", fx.url("/login"), "--no-input"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "NO_TTY");
    assert.equal(r.json.retryable, false);
    assert.ok(!existsSync(join(env.home, "profiles", "work.json")));
  });

  it("unknown profile: PROFILE_NOT_FOUND for check and delete; unsafe name rejected", async () => {
    const check = await env.hound(["profile", "check", "--profile", "ghost"]);
    assert.equal(check.exitCode, 1);
    assert.equal(check.json.error.code, "PROFILE_NOT_FOUND");
    const del = await env.hound(["profile", "delete", "--profile", "ghost", "--yes"]);
    assert.equal(del.json.error.code, "PROFILE_NOT_FOUND");
    const bad = await env.hound(["profile", "check", "--profile", "../etc"]);
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.json.error.code, "INVALID_ARGUMENT");
  });

  it("synthetic profile: list, check (valid / expired / bad --site), dry-run and delete", async () => {
    await writeSyntheticProfile(env.home, "synthetic", fx.url("/about"));
    await writeSyntheticProfile(env.home, "looks-expired", fx.url("/form")); // page with a password field

    const list = await env.hound(["profile", "list"]);
    assert.equal(list.json.data.count, 2);
    const synthetic = list.json.data.profiles.find((p: { name: string }) => p.name === "synthetic");
    assert.equal(synthetic.sites[0].origin, fx.origin);
    assert.deepEqual(Object.keys(synthetic).sort(), ["name", "sites"], "list exposes names and origins only");

    const ok = await env.hound(["profile", "check", "--profile", "synthetic"]);
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.equal(ok.json.data.state, "valid");
    assert.deepEqual(ok.json.data.cookies, { total: 0, expired: 0 });
    assert.equal(ok.json.data.sites[0].origin, fx.origin);

    const expired = await env.hound(["profile", "check", "--profile", "looks-expired"]);
    assert.equal(expired.exitCode, 0, "state is data, exit stays 0");
    assert.equal(expired.json.data.state, "expired");
    assert.match(expired.json.next_actions[0].command, /profile login/);

    const badSite = await env.hound(["profile", "check", "--profile", "synthetic", "--site", "https://other.example"]);
    assert.equal(badSite.exitCode, 2);
    assert.equal(badSite.json.error.code, "INVALID_ARGUMENT");
    assert.deepEqual(badSite.json.error.allowed, [fx.origin]);

    const dry = await env.hound(["profile", "delete", "--profile", "synthetic", "--dry-run"]);
    assert.equal(dry.json.data.dry_run, true);
    assert.equal(dry.json.data.would_delete.length, 2);
    assert.ok(existsSync(join(env.home, "profiles", "synthetic.json")));

    const del = await env.hound(["profile", "delete", "--profile", "synthetic", "--yes"]);
    assert.equal(del.exitCode, 0);
    assert.equal(del.json.data.deleted.length, 2);
    assert.ok(!existsSync(join(env.home, "profiles", "synthetic.json")));
    assert.equal((await env.hound(["profile", "list"])).json.data.count, 1);
  });
});
