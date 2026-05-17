import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const fixtureDir = path.resolve("test/fixtures/transcripts");
const expectedFixtures = ["one_sentence.elevenlabs.json", "two_takes.elevenlabs.json", "silence_gap.elevenlabs.json"];

test("ElevenLabs transcript fixtures are checked in for mocked transcription workflows", async () => {
  for (const filename of expectedFixtures) {
    const fixturePath = path.join(fixtureDir, filename);

    await access(fixturePath);

    const fixtureStat = await stat(fixturePath);
    assert.equal(fixtureStat.isFile(), true);
    assert.ok(fixtureStat.size > 500, `${filename} should contain realistic transcript metadata`);
    assert.ok(fixtureStat.size < 50_000, `${filename} should stay small enough for fast tests`);

    const transcript = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.equal(transcript.provider, "elevenlabs");
    assert.equal(typeof transcript.sourceFilename, "string");
    assert.ok(Array.isArray(transcript.words), `${filename} should include word-level timestamps`);
    assert.ok(transcript.words.length > 0, `${filename} should include at least one transcript word`);

    for (const word of transcript.words) {
      assert.equal(typeof word.text, "string");
      assert.equal(typeof word.start, "number");
      assert.equal(typeof word.end, "number");
      assert.equal(typeof word.confidence, "number");
      assert.ok(word.end >= word.start, `${filename} has a word with an invalid timestamp range`);
    }
  }
});
