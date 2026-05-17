import { access, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const fixtureDir = path.resolve("test/fixtures/media");
const expectedFixtures = ["one_sentence.mp4", "two_takes.mp4", "silence_gap.mp4"];

test("tiny generated media fixtures are checked in for video workflows", async () => {
  for (const filename of expectedFixtures) {
    const fixturePath = path.join(fixtureDir, filename);

    await access(fixturePath);

    const fixtureStat = await stat(fixturePath);
    assert.equal(fixtureStat.isFile(), true);
    assert.ok(fixtureStat.size > 1024, `${filename} should be a non-empty MP4 fixture`);
    assert.ok(fixtureStat.size < 300_000, `${filename} should stay small enough for fast tests`);
  }
});
