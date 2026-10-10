import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDatedStateCustody, DATED_STATE_RECORD_WRITTEN_TYPE } from "../src/dated-state-writing.mjs";

async function sha256sum(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "dated-state-writing-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("put lands the record at the exact expected dated path", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    const bytes = Buffer.from('{"ok":true}\n');
    const receipt = await custody.put({
      service: "npm-registry-service",
      type: "npm-registry-graph-summary",
      extension: "json",
      recordedAt: "2026-07-30T21:57:00-05:00",
      bytes,
    });

    assert.equal(receipt.type, DATED_STATE_RECORD_WRITTEN_TYPE);
    assert.equal(receipt.path, join("2026", "07", "30", "2026-07-30-npm-registry-service-npm-registry-graph-summary.json"));
    assert.equal(receipt.bytes, bytes.byteLength);
    assert.equal(receipt.sha256, await sha256sum(bytes));
    assert.ok(Object.isFrozen(receipt));

    const onDisk = await readFile(join(root, receipt.path));
    assert.ok(onDisk.equals(bytes));
  });
});

test("recordedAt's own calendar date partitions the path, not a UTC-shifted one", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    // -05:00 offset means this instant is 2026-07-31T02:57:00Z in UTC, but
    // the path must still land on the 30th — the date the caller wrote.
    const receipt = await custody.put({
      service: "some-service",
      type: "some-type",
      extension: "json",
      recordedAt: "2026-07-30T21:57:00-05:00",
      bytes: Buffer.from("x"),
    });
    assert.ok(receipt.path.startsWith(join("2026", "07", "30")));
  });
});

test("get round-trips exactly what put wrote", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    const bytes = Buffer.from("dated state contents");
    await custody.put({
      service: "svc",
      type: "kind",
      extension: "txt",
      recordedAt: "2026-01-05T00:00:00Z",
      bytes,
    });
    const read = await custody.get({ service: "svc", type: "kind", extension: "txt", recordedAt: "2026-01-05T00:00:00Z" });
    assert.equal(read.path, join("2026", "01", "05", "2026-01-05-svc-kind.txt"));
    assert.ok(read.bytes.equals(bytes));
    assert.ok(Object.isFrozen(read));
  });
});

test("get returns null for a record never written", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    const read = await custody.get({ service: "svc", type: "kind", extension: "txt", recordedAt: "2026-01-05T00:00:00Z" });
    assert.equal(read, null);
  });
});

test("append accumulates onto the same dated path across multiple puts", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    const line1 = Buffer.from('{"n":1}\n');
    const line2 = Buffer.from('{"n":2}\n');
    const args = { service: "log-service", type: "events", extension: "jsonl", recordedAt: "2026-03-11T12:00:00Z" };

    const first = await custody.put({ ...args, bytes: line1, append: true });
    assert.equal(first.bytes, line1.byteLength);

    const second = await custody.put({ ...args, bytes: line2, append: true });
    assert.equal(second.bytes, line1.byteLength + line2.byteLength);
    assert.equal(second.sha256, await sha256sum(Buffer.concat([line1, line2])));

    const onDisk = await readFile(join(root, second.path));
    assert.ok(onDisk.equals(Buffer.concat([line1, line2])));
  });
});

test("a non-append put leaves no leftover temp file in the dated directory", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    const receipt = await custody.put({
      service: "svc",
      type: "kind",
      extension: "txt",
      recordedAt: "2026-02-02T00:00:00Z",
      bytes: Buffer.from("payload"),
    });
    const dir = join(root, "2026", "02", "02");
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["2026-02-02-svc-kind.txt"]);
    assert.equal(entries.some((name) => name.startsWith(".tmp-")), false);
    void receipt;
  });
});

test("put refuses a missing recordedAt", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    await assert.rejects(
      () => custody.put({ service: "svc", type: "kind", extension: "txt", bytes: Buffer.from("x") }),
      TypeError,
    );
  });
});

test("put refuses a non-ISO-8601 recordedAt", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    await assert.rejects(
      () => custody.put({ service: "svc", type: "kind", extension: "txt", recordedAt: "07/30/2026", bytes: Buffer.from("x") }),
      TypeError,
    );
  });
});

test("put refuses a calendar-invalid recordedAt", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    await assert.rejects(
      () => custody.put({ service: "svc", type: "kind", extension: "txt", recordedAt: "2026-02-30T00:00:00Z", bytes: Buffer.from("x") }),
      TypeError,
    );
  });
});

test("put refuses a service that is not kebab-case", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    await assert.rejects(
      () => custody.put({ service: "Npm_Registry", type: "kind", extension: "txt", recordedAt: "2026-01-01T00:00:00Z", bytes: Buffer.from("x") }),
      TypeError,
    );
  });
});

test("put refuses a type that is not kebab-case", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    await assert.rejects(
      () => custody.put({ service: "svc", type: "Bad Type", extension: "txt", recordedAt: "2026-01-01T00:00:00Z", bytes: Buffer.from("x") }),
      TypeError,
    );
  });
});

test("put refuses an extension outside [a-z0-9]+", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    await assert.rejects(
      () => custody.put({ service: "svc", type: "kind", extension: "tar.gz", recordedAt: "2026-01-01T00:00:00Z", bytes: Buffer.from("x") }),
      TypeError,
    );
  });
});

test("put refuses an absolute-path service (path traversal)", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    await assert.rejects(
      () => custody.put({ service: "/etc/passwd", type: "kind", extension: "txt", recordedAt: "2026-01-01T00:00:00Z", bytes: Buffer.from("x") }),
      TypeError,
    );
  });
});

test("put refuses a dot-containing type (path traversal)", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    await assert.rejects(
      () => custody.put({ service: "svc", type: "../../etc", extension: "txt", recordedAt: "2026-01-01T00:00:00Z", bytes: Buffer.from("x") }),
      TypeError,
    );
  });
});

test("put's sha256 matches an independent sha256sum of the on-disk bytes", async () => {
  await withRoot(async (root) => {
    const custody = createDatedStateCustody({ root });
    const bytes = Buffer.from("independent hash check");
    const receipt = await custody.put({
      service: "svc",
      type: "kind",
      extension: "txt",
      recordedAt: "2026-04-04T00:00:00Z",
      bytes,
    });
    const onDisk = await readFile(join(root, receipt.path));
    const independent = createHash("sha256").update(onDisk).digest("hex");
    assert.equal(receipt.sha256, independent);
  });
});
