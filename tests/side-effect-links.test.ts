/** Read level: links that look like GET links with side effects (logout, delete, unsubscribe, ...) are refused. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sideEffectLinkReason } from "../packages/core/src/browserd/sideeffect.ts";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const blocked = (href: string, ...labels: string[]) => sideEffectLinkReason(`https://shop.test${href}`, labels) !== null;

describe("sideEffectLinkReason (unit)", () => {
  it("blocks logout, sign out, delete, unsubscribe and friends in the path", () => {
    for (const p of [
      "/logout", "/log-out", "/signout", "/sign-out", "/sign_out", "/signOut", "/logoff", "/Logout.aspx", "/auth/logout.php", "/salir", "/cerrar-sesion", "/cerrar-sesión",
      "/users/42/delete", "/items/7/remove", "/destroy", "/eliminar", "/borrar-cuenta", "/unsubscribe", "/account/revoke", "/deactivate", "/desactivar", "/cancel-subscription",
      "/cancelar-suscripcion", "/dar-de-baja", "/darse-de-baja", "/delete-account-help",
    ]) {
      assert.ok(blocked(p), p);
    }
  });
  it("does not block listings, prose slugs and look-alikes", () => {
    for (const p of [
      "/deleted-items", "/removal-policy", "/removed", "/destroyer", "/logoutput", "/blog/how-to-remove-stains", "/blog/why-you-should-delete-old-emails-today", "/cancellations",
      "/salary", "/about", "/", "/products/delete-key-cap-set-black-edition", "/sign", "/out", "/eliminated",
    ]) {
      assert.ok(!blocked(p), p);
    }
  });
  it("query: deny words in keys, and in the values of action-like keys only", () => {
    for (const q of ["?action=delete", "?action=remove&id=4", "?do=logout", "?op=Sign-Out", "?cmd=cancelar_suscripcion", "?logout=1", "?delete_id=5", "?signout", "?mode=destroy"]) {
      assert.ok(blocked(`/x${q}`), q);
    }
    for (const q of ["?q=delete", "?search=logout+page", "?removed=1", "?deleted=yes", "?action=view", "?sort=remove-date-asc-with-many-words", "?title=sign out"]) {
      assert.ok(!blocked(`/x${q}`), q);
    }
  });
  it("the fragment is ignored", () => {
    assert.ok(!blocked("/page#logout"));
  });
  it("labels: short texts only, whole words, accents and case folded", () => {
    for (const t of ["Log out", "LOGOUT", "Sign out", "Cerrar sesión", "Cerrar Sesion", "Salir", "Delete", "Delete my account", "Remove", "Eliminar cuenta", "Borrar", "Unsubscribe", "Darse de baja", "Cancel subscription", "Cancelar mi suscripción", "Revoke access", "Desactivar cuenta"]) {
      assert.ok(blocked("/ok", t), t);
    }
    for (const t of ["Deleted items", "Removal policy", "Read more", "Salary guide", "Designing resilient systems", "How to remove stains from your favourite shirt and more", "Cancel", "Order history"]) {
      assert.ok(!blocked("/ok", t), t);
    }
    assert.ok(blocked("/ok", "Read more", "Unsubscribe from emails"), "any of the labels counts");
  });
  it("review round 2: salir only in short words, longer logout phrases, close account, unfollow, filter labels exempt, _method override", () => {
    for (const p of ["/salir", "/cerrar-la-sesion", "/cerrar-sesion", "/desconectar", "/unfollow", "/unregister", "/account/close", "/cuenta/cerrar", "/quitar"]) assert.ok(blocked(p), p);
    for (const p of ["/planes-para-salir-de-noche", "/closet", "/accounts", "/blog/close-your-account-balance-today-now"]) assert.ok(!blocked(p), p);
    for (const t of ["Cerrar la sesión", "Desconectar", "Unfollow", "Unregister", "Close account", "Salir", "Quitar del carrito"]) assert.ok(blocked("/ok", t), t);
    for (const t of ["Remove filter", "Remove filters", "Quitar filtros", "Eliminar filtro", "Borrar filtros", "Salir de noche con amigos hoy"]) assert.ok(!blocked("/ok", t), t);
    for (const q of ["?_method=delete", "?_method=PUT", "?_method=patch&id=1", "?_method=post"]) assert.ok(blocked(`/x${q}`), q);
    assert.ok(!blocked("/x?_method=get"));
  });

  it("the reason names the matched term, not the page text", () => {
    const r = sideEffectLinkReason("https://shop.test/ok", ["Delete secret-9999"]);
    assert.match(r!, /side-effect link/);
    assert.match(r!, /--actions interact/);
    assert.match(r!, /"delete"/);
    assert.doesNotMatch(r!, /9999/);
    assert.equal(sideEffectLinkReason("not a url", ["Delete"]), null);
  });
});

describe("read level: side-effect links (end to end)", () => {
  let env: Env;
  let fx: Fixture;
  const RD = "sfx-read";
  const IA = "sfx-ia";
  const rd = (args: string[]) => env.hound(args.concat("--session-name", RD));
  const ia = (args: string[]) => env.hound(args.concat("--session-name", IA));

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    const opened = await Promise.all([env.open(RD), env.open(IA, ["--actions", "interact"])]);
    for (const o of opened) assert.equal(o.exitCode, 0, o.stderr);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  const snapshot = async (run: typeof rd) => {
    assert.equal((await run(["page", "navigate", "--url", fx.url("/sidefx")])).exitCode, 0);
    return (await run(["page", "snapshot", "--limit-chars", "100000"])).json.data.snapshot as string;
  };

  it("refuses logout/delete/remove/unsubscribe links by URL or label with ACTION_BLOCKED and does not navigate", async () => {
    const s = await snapshot(rd);
    for (const name of ["Leave", "Account page", "Go on", "Item four", "Cerrar sesión", "Unsubscribe from emails", "Delete log export"]) {
      const r = await rd(["element", "click", "--ref", refFor(s, new RegExp(`link "${name}"`))]);
      assert.equal(r.exitCode, 1, name);
      assert.equal(r.json.error.code, "ACTION_BLOCKED", name);
      assert.match(r.json.error.message, /side-effect link/, name);
      assert.match(r.json.error.message, /--actions interact/, name);
      assert.match(r.json.suggested_fix.command, /--actions interact/);
    }
    assert.match((await rd(["browser", "status"])).json.data.url, /\/sidefx$/, "no click went through");
  });

  it("element download uses the same policy", async () => {
    const s = await snapshot(rd);
    const r = await rd(["element", "download", "--ref", refFor(s, /link "Delete log export"/)]);
    assert.equal(r.json.error.code, "ACTION_BLOCKED");
    assert.match(r.json.error.message, /side-effect link/);
  });

  it("ordinary links still work: listings, prose slugs, search queries", async () => {
    for (const [name, path] of [["Deleted items", "/deleted-items"], ["Tips for stains", "/blog/how-to-remove-stains"], ["Search docs", "/docs"], ["Learn about us", "/about"]] as const) {
      const s = await snapshot(rd);
      const r = await rd(["element", "click", "--ref", refFor(s, new RegExp(`link "${name}"`))]);
      assert.equal(r.exitCode, 0, `${name}: ${r.stdout}`);
      assert.equal(new URL(r.json.data.url).pathname, path);
    }
  });

  it("with --actions interact the same links are followed", async () => {
    const s = await snapshot(ia);
    const r = await ia(["element", "click", "--ref", refFor(s, /link "Leave"/)]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(new URL(r.json.data.url).pathname, "/logout");
  });

  it("the docs no longer claim side-effect links go undetected, and the schema says so", async () => {
    const schema = JSON.parse((await env.raw(["element", "click", "--schema"])).stdout);
    assert.doesNotMatch(JSON.stringify(schema), /are not detected/);
    assert.match(schema.description, /logout|side effect/i);
  });
});
