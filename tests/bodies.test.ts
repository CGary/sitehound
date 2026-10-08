/** Unit tests for body redaction and filename sanitizing (no browser). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBinaryType, isSecretKey, mediaType, numberedName, redactBody, sanitizeFilename } from "../packages/core/src/browserd/bodies.ts";
import { MAX_OP_TIMEOUT_MS, REQUEST_BUFFER_CAP, TYPE_MAX_CHARS, typingFits, typingTimeoutMs } from "../packages/core/src/browserd/limits.ts";

const body = (text: string, type: string) => redactBody(Buffer.from(text), type);

describe("sanitizeFilename", () => {
  it("strips paths, control characters, leading dots and caps the length", () => {
    assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
    assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
    assert.equal(sanitizeFilename("C:\\Users\\x\\inform\u00e9.xlsx"), "inform\u00e9.xlsx");
    assert.equal(sanitizeFilename("..hidden"), "hidden");
    assert.equal(sanitizeFilename("a\u0000b\nc\u202e.txt"), "abc.txt");
    assert.equal(sanitizeFilename(""), "download.bin");
    assert.equal(sanitizeFilename("..."), "download.bin");
    assert.equal(sanitizeFilename("/"), "download.bin");
    const long = sanitizeFilename(`${"a".repeat(500)}.pdf`);
    assert.ok(long.length <= 120 && long.endsWith(".pdf"), long);
    assert.ok(Buffer.byteLength(sanitizeFilename(`${"\u00e9".repeat(300)}.pdf`)) <= 255);
  });
  it("numberedName keeps the extension", () => {
    assert.equal(numberedName("report.pdf", 2), "report-2.pdf");
    assert.equal(numberedName("noext", 3), "noext-3");
  });
});

describe("isSecretKey", () => {
  it("matches secret-looking keys by word, not by substring accident", () => {
    for (const k of ["password", "userPassword", "access_token", "X-CSRF-Token", "api_key", "apiKey", "Authorization", "sessionId", "cookie", "otp", "pin", "cvv", "card_number", "client_secret", "xsrf"]) {
      assert.ok(isSecretKey(k), k);
    }
    for (const k of ["shipping", "author", "name", "city", "mapping", "spinner", "title", "email"]) assert.ok(!isSecretKey(k), k);
  });
});

describe("redactBody", () => {
  it("JSON: secret keys at any depth, URLs stripped, tokens scrubbed, other values kept", () => {
    const r = body(JSON.stringify({ a: { b: [{ password: "x", c: 1 }], Token: { nested: "y" } }, link: "https://h.test/p?code=1#f", id: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4", ok: true }), "application/json; charset=utf-8");
    assert.equal(r.format, "json");
    const v = JSON.parse(r.text!);
    assert.deepEqual(v.a.b, [{ password: "[redacted]", c: 1 }]);
    assert.equal(v.a.Token, "[redacted]");
    assert.equal(v.link, "https://h.test/p");
    assert.equal(v.id, "[token]");
    assert.equal(v.ok, true);
  });
  it("JSON sniffed from text/plain, and invalid JSON falls back to text redaction", () => {
    assert.equal(body('{"password":"abc"}', "text/plain").format, "json");
    const bad = body('{"password": "abc12345', "application/json");
    assert.equal(bad.format, "text");
    assert.doesNotMatch(bad.text!, /abc12345/);
  });
  it("form-urlencoded: pairs, secret keys redacted", () => {
    const r = body("name=ann&password=pw1&csrf_token=zz&city=Madrid+City", "application/x-www-form-urlencoded");
    assert.equal(r.format, "form");
    assert.equal(r.text, "name=ann\npassword=[redacted]\ncsrf_token=[redacted]\ncity=Madrid City");
  });
  it("multipart: names and sizes; file parts never show a value", () => {
    const b = "XBOUND";
    const raw =
      `--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="secret_note"\r\n\r\ntopsecret\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nFILEBODY\r\n--${b}--\r\n`;
    const r = body(raw, `multipart/form-data; boundary=${b}`);
    assert.equal(r.format, "multipart");
    assert.match(r.text!, /title: 5 bytes, value "Hello"/);
    assert.match(r.text!, /secret_note: 9 bytes, value "\[redacted\]"/);
    assert.match(r.text!, /file: file, 8 bytes/);
    assert.doesNotMatch(r.text!, /FILEBODY|topsecret|a\.txt/);
  });
  it("text: secret pairs and tokens masked; binary: no content", () => {
    const t = body("Authorization: Bearer " + "abcdef0123456789abcdef0123\nsession=xyz12345 see https://h.test/a?b=1", "text/html");
    assert.equal(t.format, "text");
    assert.doesNotMatch(t.text!, /abcdef0123|xyz12345|b=1/);
    assert.deepEqual(redactBody(Buffer.from([0, 1, 2, 255]), "application/octet-stream"), { format: "binary" });
    assert.deepEqual(redactBody(Buffer.from([0, 1, 2, 255]), undefined), { format: "binary" });
    assert.equal(redactBody(Buffer.from('{"a":1}'), undefined).format, "json");
    assert.ok(isBinaryType("image/png") && !isBinaryType("application/json") && !isBinaryType(undefined));
    assert.equal(mediaType("Application/JSON; charset=utf-8"), "application/json");
  });
});

describe("limits", () => {
  it("typing time grows with chars x delay and stays under the 600 s op limit", () => {
    assert.ok(typingTimeoutMs(1000, 30) > 30_000);
    assert.equal(typingTimeoutMs(TYPE_MAX_CHARS, 1000), 600_000);
    assert.equal(typingTimeoutMs(0, 30), 10_000);
    assert.equal(REQUEST_BUFFER_CAP, 500);
  });
  it("typing time counts the per-key overhead, even with --delay-ms 0", () => {
    assert.equal(typingTimeoutMs(5000, 0), 10_000 + 5000 * 5, "delay 0 is not free");
    assert.ok(typingTimeoutMs(5000, 0) > 10_000 + 5000 * 0);
    assert.equal(typingFits(2000, 290), true);
    assert.equal(typingFits(2000, 300), false);
    assert.equal(typingFits(TYPE_MAX_CHARS, 0), true);
    assert.equal(MAX_OP_TIMEOUT_MS, 600_000);
  });
});

describe("redaction regressions (review findings)", () => {
  const secrets = /Hunter2pw|4711|123456|S3cond|TOPSECRET|4242424242424242|4242 4242 4242 4242/;
  const red = (text: string | Buffer, type?: string) => {
    const r = redactBody(Buffer.isBuffer(text) ? text : Buffer.from(text), type);
    return r.text ?? `[${r.format}]`;
  };

  it("1: a JSON document posted as a form never leaks through the form key; bare JWT keys are masked", () => {
    const form = red('{"username":"jane","password":"Hunter2pw","pin":"4711"}', "application/x-www-form-urlencoded; charset=UTF-8");
    assert.doesNotMatch(form, secrets);
    assert.match(form, /jane/);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123ghiJKL456";
    assert.doesNotMatch(red(jwt, "application/x-www-form-urlencoded"), /eyJ/);
    assert.doesNotMatch(red(`${jwt}=1`, "application/x-www-form-urlencoded"), /eyJ/);
    assert.doesNotMatch(red(JSON.stringify({ [jwt]: true }), "application/json"), /eyJ/, "JSON keys are scrubbed too");
    assert.doesNotMatch(red('{"password": "Hunter2pw', "application/x-www-form-urlencoded"), secrets, "cut-off JSON form");
    assert.doesNotMatch(red("q=" + encodeURIComponent('{"pin":"4711"}'), "application/x-www-form-urlencoded"), secrets, "JSON in a form value");
  });

  it("2: name/value pairs (serializeArray) redact the value of a secret name, nested too", () => {
    for (const body of [
      JSON.stringify([{ name: "password", value: "Hunter2pw" }, { name: "city", value: "Madrid" }]),
      JSON.stringify({ field: "pin", val: "4711" }),
      JSON.stringify({ fields: [{ id: "otp", v: "123456" }] }),
    ]) {
      assert.doesNotMatch(red(body, "application/json"), secrets, body);
    }
    assert.match(red(JSON.stringify([{ name: "city", value: "Madrid" }]), "application/json"), /Madrid/);
    const nested = red("data=" + encodeURIComponent(JSON.stringify([{ name: "password", value: "Hunter2pw" }])), "application/x-www-form-urlencoded");
    assert.doesNotMatch(nested, secrets);
    assert.doesNotMatch(red("name=pin&value=4711", "application/x-www-form-urlencoded"), secrets);
  });

  it("3: free text uses the same key semantics (XML, text/plain, JS literals, JSON in a string, GraphQL)", () => {
    assert.doesNotMatch(red("<login><password>Hunter2pw</password><pin>4711</pin></login>", "application/xml"), secrets);
    assert.doesNotMatch(red('<input type="hidden" name="csrf_token" value="Hunter2pw">', "text/html"), secrets);
    assert.doesNotMatch(red("pin=4711&otp=123456&cvv=123", "text/plain"), secrets);
    assert.doesNotMatch(red("var cfg = {password: 'Hunter2pw', pin: '4711'};", "application/javascript"), secrets);
    assert.doesNotMatch(red(JSON.stringify({ payload: JSON.stringify({ pin: "4711", cvv: "123" }) }), "application/json"), secrets);
    assert.doesNotMatch(red(JSON.stringify({ query: 'mutation { verify(pin: "4711", otp: "123456") }' }), "application/json"), secrets);
    assert.doesNotMatch(red("password: Hunter2pw\npin: 4711\n", "application/yaml"), secrets);
    assert.match(red("city=Madrid&name=ann", "text/plain"), /city=Madrid&name=ann/, "ordinary pairs are kept");
  });

  it("5: invalid-JSON fallback redacts whole objects and arrays under secret keys", () => {
    assert.doesNotMatch(red('{"auth": {"user":"a","pw":"Hunter2pw"}, "x":1,', "application/json"), secrets);
    assert.doesNotMatch(red('{"credentials": ["x","S3cond"], "x":1,', "application/json"), secrets);
    assert.doesNotMatch(red('cb({"credentials": {"a": [1, {"b": "Hunter2pw"}]}});', "application/javascript"), secrets);
    assert.doesNotMatch(red('{"auth": {"user":"a","pw":"Hunter2pw"', "application/json"), secrets, "unbalanced: redacted to the end");
  });

  it("6: long bodies are never cut silently", () => {
    const text = red("word ".repeat(60_000), "text/plain");
    assert.equal(text.length, 300_000);
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ id: i, password: "Hunter2pw", note: "x".repeat(30) }));
    const json = red(JSON.stringify(rows), "application/json");
    assert.ok(json.length > 1_000_000);
    assert.doesNotMatch(json, /Hunter2pw/);
    assert.equal(JSON.parse(json).length, 30_000, "valid JSON above 1M characters stays JSON");
    const long = red(JSON.stringify({ note: "x ".repeat(80_000) + " password=Hunter2pw" }), "application/json");
    assert.doesNotMatch(long, secrets);
    assert.ok(long.length > 160_000);
  });

  it("7: more secret key names, session ids and card numbers", () => {
    for (const k of ["pw", "passw", "pword", "PHPSESSID", "sid", "sessid", "JSESSIONID", "pan"]) assert.ok(isSecretKey(k), k);
    const body = red(JSON.stringify({ username: "a", pw: "Hunter2pw", PHPSESSID: "abc", card: { number: "4242424242424242", holder: "J" } }), "application/json");
    assert.doesNotMatch(body, secrets);
    assert.doesNotMatch(body, /abc"/);
    assert.doesNotMatch(red(JSON.stringify({ note: "pay with 4242 4242 4242 4242 please" }), "application/json"), secrets);
    assert.match(red(JSON.stringify({ n: "order 1234567890123" }), "application/json"), /1234567890123/, "digit runs failing Luhn are kept");
  });

  it("8: UTF-16 bodies are decoded (or dropped), never leaked through NUL-interleaved text", () => {
    const le = Buffer.from(JSON.stringify({ password: "Hunter2pw", name: "ann" }), "utf16le");
    const out = red(le, "application/json; charset=utf-16le");
    assert.doesNotMatch(out, /Hunter2pw/);
    assert.match(out, /ann/);
    const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), le]);
    assert.doesNotMatch(red(bom, "application/json"), /H\u0000|Hunter2pw/);
    assert.equal(redactBody(le, "application/json").format, "binary", "NUL bytes under a utf-8 label: dropped, not shown");
    assert.equal(redactBody(le, "application/json; charset=nonsense-9").format, "binary");
  });

  it("12: suggested file names lose tokens and e-mail addresses", () => {
    const name = sanitizeFilename("jane.doe@example.com-A1b2C3d4E5f6G7h8I9j0K1l2M3.txt");
    assert.doesNotMatch(name, /jane|example|A1b2C3/);
    assert.ok(name.endsWith(".txt"));
  });
});
