/** Value-shape redaction of plain text in `element read` and `page find`: one-time codes, PINs and card numbers. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { hintsOtp, maskOtpLines, redactFindLines, redactReadText } from "../packages/core/src/browserd/read.ts";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

describe("redactReadText / maskOtpLines (unit)", () => {
  it("masks standalone 4-8 digit codes next to a code word, in English and Spanish, with or without a separator", () => {
    assert.equal(redactReadText("Your verification code is 482913. It expires in 10 minutes."), "Your verification code is [code]. It expires in 10 minutes.");
    assert.equal(redactReadText("Tu código de verificación: 907153"), "Tu código de verificación: [code]");
    assert.equal(redactReadText("Use PIN 8842 to continue"), "Use PIN [code] to continue");
    assert.equal(redactReadText("OTP: 482 913"), "OTP: [code]");
    assert.equal(redactReadText("clave 123-456"), "clave [code]");
    assert.equal(redactReadText("Verification code\n482913\nthanks"), "Verification code\n[code]\nthanks", "a value under its label");
    assert.equal(redactReadText("Verification code\n\n482913"), "Verification code\n\n[code]", "a blank line does not break the pairing");
  });

  it("the element's own hints (name, label, class, ancestors) make every standalone 4-8 digit number in it a code", () => {
    assert.equal(redactReadText("731904", "otp-box"), "[code]");
    assert.equal(redactReadText("8842", "Security PIN"), "[code]");
    assert.equal(redactReadText("907153", "Código de verificación"), "[code]");
    assert.equal(redactReadText("731904", "sms-code"), "[code]");
    assert.equal(redactReadText("731904", "totp field"), "[code]");
  });

  it("leaves generic numbers alone: prices, dates, times, quantities, zip and promo codes, long ids", () => {
    for (const t of [
      "Total 4500 EUR, order 123456 on 2024-01-05 at 12:30",
      "Quantity 3456 shipped to zip code 28001",
      "Use promo code 2024 for 15% off",
      "Price: $1234.50 or 1,234.50",
      "Call 555-1234 or visit 1234 Main Street",
      "Invoice 20240105 total 4500",
      "Error code 4040 from build 8812",
      "Year 2024, page 1234",
    ]) {
      assert.equal(redactReadText(t), t, t);
    }
    assert.equal(redactReadText("Total 4500", "price-box shopping cart"), "Total 4500");
  });

  it("still masks tokens and Luhn card numbers; epoch milliseconds pass", () => {
    assert.equal(redactReadText(`Key: ghp${"_"}${"abcdefghijklmnopqrstuvwxyz0123456789ab"} end`), "Key: [token] end");
    assert.equal(redactReadText("Paid with card 4242 4242 4242 4242 at 1723456789011 ms"), "Paid with card [pan] at 1723456789011 ms");
    assert.equal(redactReadText("4242424242424242"), "[pan]");
    assert.equal(redactReadText("1700000000004"), "1700000000004");
    assert.equal(redactReadText("4000000000006", "card-number"), "[pan]", "a card hint masks any Luhn-valid 13-19 digits");
  });

  it("review round 2: a short capital prefix before the code (G-482913) is masked; UnionPay and friends in find lines", () => {
    assert.equal(redactReadText("G-482913 is your Google verification code"), "G-[code] is your Google verification code");
    assert.equal(redactReadText("Your code: AB-123456"), "Your code: AB-[code]");
    assert.equal(redactReadText("Order ABCD-1234 shipped"), "Order ABCD-1234 shipped");
    assert.deepEqual(redactFindLines(["- paragraph: UnionPay 6200000000000005 ok", "- paragraph: 4012888888881881 visa"]), ["- paragraph: UnionPay [pan] ok", "- paragraph: [pan] visa"]);
    assert.equal(redactReadText("pan 6200000000000005"), "pan [pan]");
  });

  it("hintsOtp ignores non-secret codes", () => {
    for (const t of ["zip code", "Postal Code", "promo code", "Country code", "source code", "bar code", "color code"]) assert.equal(hintsOtp(t), false, t);
    for (const t of ["code", "Verification", "PIN", "otp", "código", "clave", "one-time", "2FA", "security code"]) assert.equal(hintsOtp(t), true, t);
    assert.equal(hintsOtp("pinned items"), false);
    assert.equal(hintsOtp("encoded"), false);
  });

  it("maskOtpLines and redactFindLines keep the line structure", () => {
    assert.deepEqual(maskOtpLines(["a 1234", "code 5678", "9012", "Your code", "", "3456", "7890"]), ["a 1234", "code [code]", "9012", "Your code", "", "[code]", "7890"]);
    assert.deepEqual(redactFindLines(["- paragraph [ref=e5]: Code 482913", "- link \"Order 123456\" [ref=e6]"]), ["- paragraph [ref=e5]: Code [code]", "- link \"Order 123456\" [ref=e6]"]);
  });
});

describe("element read and page find (end to end)", () => {
  let env: Env;
  let fx: Fixture;
  const RD = "red-read";
  const rd = (args: string[]) => env.hound(args.concat("--session-name", RD));
  let snapshot = "";

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    assert.equal((await env.open(RD)).exitCode, 0);
    assert.equal((await rd(["page", "navigate", "--url", fx.url("/codes")])).exitCode, 0);
    snapshot = (await rd(["page", "snapshot", "--limit-chars", "100000"])).json.data.snapshot;
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  const text = async (re: RegExp): Promise<string> => {
    const r = await rd(["element", "read", "--ref", refFor(snapshot, re)]);
    assert.equal(r.exitCode, 0, r.stdout);
    return r.json.data.text as string;
  };

  it("a code mentioned in the text itself is masked; the rest of the text stays", async () => {
    const t = await text(/paragraph.*Your verification code/);
    assert.equal(t, "Your verification code is [code]. It expires in 10 minutes.");
  });

  it("a code in an element whose class, aria-label or neighbouring label says so is masked", async () => {
    assert.equal(await text(/paragraph.*731904/), "[code]");
    assert.equal(await text(/paragraph.*8842/), "[code]");
    assert.equal(await text(/paragraph.*907153/), "[code]");
  });

  it("ordinary numbers are not masked", async () => {
    assert.equal(await text(/paragraph.*Total 4500/), "Total 4500 EUR, order 123456 on 2024-01-05 at 12:30");
    assert.equal(await text(/paragraph.*Quantity 3456/), "Quantity 3456 shipped to zip code 28001");
  });

  it("card numbers are masked, an epoch in milliseconds is not", async () => {
    assert.equal(await text(/paragraph.*Paid with card/), "Paid with card [pan] at 1723456789011 ms");
    assert.equal(await text(/paragraph.*Created/), "Created 1700000000004");
  });

  it("the raw digits never reach stdout or stderr", async () => {
    const outputs: string[] = [];
    for (const re of [/paragraph.*Your verification code/, /paragraph.*731904/, /paragraph.*8842/, /paragraph.*907153/, /paragraph.*Paid with card/]) {
      const r = await rd(["element", "read", "--ref", refFor(snapshot, re)]);
      outputs.push(r.stdout + r.stderr);
    }
    assert.doesNotMatch(outputs.join("\n"), /482913|731904|8842|907153|4242 4242/);
  });

  it("page find masks codes after a code label and card numbers in its matches and context, but still finds them", async () => {
    const byCode = await rd(["page", "find", "--text", "482913"]);
    assert.equal(byCode.json.data.total, 1, "matching uses the raw line");
    assert.doesNotMatch(byCode.stdout, /482913/);
    assert.match(byCode.json.data.matches[0].text, /\[code\]/);
    const pairing = await rd(["page", "find", "--text", "Código de verificación", "--context", "1"]);
    assert.doesNotMatch(pairing.stdout, /907153/);
    assert.match(JSON.stringify(pairing.json.data.matches[0].after), /\[code\]/);
    const card = await rd(["page", "find", "--text", "Paid with card"]);
    assert.doesNotMatch(card.stdout, /4242 4242/);
    assert.match(card.json.data.matches[0].text, /\[pan\]/);
    const generic = await rd(["page", "find", "--text", "Total 4500"]);
    assert.match(generic.json.data.matches[0].text, /Total 4500 EUR, order 123456/);
  });
});
