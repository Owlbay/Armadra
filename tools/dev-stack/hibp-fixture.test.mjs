import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { rangeResponse, sha1Hex, startHibpFixture } from "./hibp-fixture.mjs";

let fixture;
before(async () => {
  fixture = await startHibpFixture();
});
after(() => fixture.close());

test("命中：password 的后缀与次数在它的前缀里", async () => {
  const hash = sha1Hex("password");
  assert.equal(hash.slice(0, 5), "5BAA6");
  const response = await fetch(`${fixture.base}/range/5baa6`);
  assert.equal(response.status, 200);
  const lines = (await response.text()).split("\r\n");
  assert.ok(lines.includes(`${hash.slice(5)}:52256179`));
  for (const line of lines) assert.match(line, /^[0-9A-F]{35}:\d+$/);
});

test("没命中：一份非空、确定性的响应", async () => {
  const hash = sha1Hex("correct horse battery staple armadra");
  const first = rangeResponse(hash.slice(0, 5));
  assert.equal(first, rangeResponse(hash.slice(0, 5)));
  assert.ok(!first.includes(hash.slice(5)));
  assert.ok(first.split("\r\n").length >= 12);
});

test("Add-Padding 补到至少 800 行，补出来的次数为 0", async () => {
  const response = await fetch(`${fixture.base}/range/5BAA6`, {
    headers: { "Add-Padding": "true" },
  });
  const lines = (await response.text()).split("\r\n");
  assert.ok(lines.length >= 800);
  assert.ok(lines.filter((line) => line.endsWith(":0")).length >= 780);
  assert.ok(lines.includes(`${sha1Hex("password").slice(5)}:52256179`));
});

test("坏前缀 400，健康检查 200", async () => {
  assert.equal((await fetch(`${fixture.base}/range/XYZ`)).status, 400);
  assert.equal(
    (await fetch(`${fixture.base}/range/5BAA6?mode=ntlm`)).status,
    400,
  );
  assert.equal((await fetch(`${fixture.base}/health`)).status, 200);
});
