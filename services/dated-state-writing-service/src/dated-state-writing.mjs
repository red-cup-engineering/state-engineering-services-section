import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Same put/get shape as
// resource-brokerage-service-section/services/immutable-content-custody-service's
// createImmutableContentCustody, but the key is derived from the house
// dated-state path law instead of a content hash: a record is addressed by
// who wrote it, what kind of record it is, and when it was recorded — never
// by the bytes themselves.
//
// The path law itself mirrors
// board-of-directors/.../leader-movement-team/src/harvest-leader-speech.mjs's
// datePartition/recordPathFor: <root>/<YYYY>/<MM>/<DD>/<YYYY-MM-DD>-<slug>.<ext>.
// It differs from that prior art in one deliberate way — the Y/M/D come
// straight off the recordedAt string's own calendar date, not off a
// UTC-converted Date object, so a caller in any offset partitions on the
// date they wrote down rather than one that can roll over at a UTC
// boundary.
const RECORD_WRITTEN_TYPE = "DatedStateRecordWritten";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EXTENSION_RE = /^[a-z0-9]+$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/;

function validateSlug(value, label) {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    throw new TypeError(`${label} must be kebab-case ([a-z0-9]+(-[a-z0-9]+)*) with no path separators or dots, got ${JSON.stringify(value)}`);
  }
}

function validateExtension(value) {
  if (typeof value !== "string" || !EXTENSION_RE.test(value)) {
    throw new TypeError(`extension must match [a-z0-9]+, got ${JSON.stringify(value)}`);
  }
}

// Extracts the calendar date a recordedAt timestamp names, straight from
// its own digits — never through a Date object's UTC-shifted fields, so
// "2026-07-30T21:57:00-05:00" partitions to 2026-07-30, the date the
// caller actually wrote, not the 2026-07-31 a UTC conversion would give.
function datePartsFor(recordedAt) {
  if (typeof recordedAt !== "string" || !recordedAt) {
    throw new TypeError("recordedAt is required and must be an ISO 8601 / RFC 3339 timestamp string");
  }
  const match = RFC3339_RE.exec(recordedAt);
  if (!match) {
    throw new TypeError(`recordedAt must be an ISO 8601 / RFC 3339 timestamp string, got ${JSON.stringify(recordedAt)}`);
  }
  const [, yStr, mStr, dStr] = match;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  // Catches calendar-invalid dates (month 13, February 30, ...) that the
  // regexp's digit shape alone lets through.
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) {
    throw new TypeError(`recordedAt is not a valid calendar date: ${recordedAt}`);
  }
  return { y: yStr, m: mStr, d: dStr, stamp: `${yStr}-${mStr}-${dStr}` };
}

function recordPathFor({ root, service, type, extension, recordedAt }) {
  validateSlug(service, "service");
  validateSlug(type, "type");
  validateExtension(extension);
  const { y, m, d, stamp } = datePartsFor(recordedAt);
  const relative = join(y, m, d, `${stamp}-${service}-${type}.${extension}`);
  return { relative, absolute: join(root, relative), dir: join(root, y, m, d) };
}

export function createDatedStateCustody({ root } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");

  async function put({ service, type, extension, recordedAt, bytes, append = false }) {
    if (bytes === undefined || bytes === null) throw new TypeError("bytes is required");
    const { relative, absolute, dir } = recordPathFor({ root, service, type, extension, recordedAt });
    const payload = Buffer.from(bytes);

    await mkdir(dir, { recursive: true });
    if (append) {
      await appendFile(absolute, payload);
    } else {
      // Atomic write: stage in the same directory (so the rename is a same-
      // filesystem, single-inode-swap operation), then rename over the
      // final path. A crash mid-write leaves only the uniquely-named temp
      // file behind, never a half-written record at the real path.
      const tmp = join(dir, `.tmp-${randomBytes(9).toString("hex")}`);
      await writeFile(tmp, payload);
      await rename(tmp, absolute);
    }

    const written = await readFile(absolute);
    return Object.freeze({
      type: RECORD_WRITTEN_TYPE,
      path: relative,
      bytes: written.byteLength,
      sha256: createHash("sha256").update(written).digest("hex"),
    });
  }

  async function get({ service, type, extension, recordedAt }) {
    const { relative, absolute } = recordPathFor({ root, service, type, extension, recordedAt });
    let contents;
    try {
      contents = await readFile(absolute);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    return Object.freeze({ path: relative, bytes: contents });
  }

  return Object.freeze({ put, get });
}

export const DATED_STATE_RECORD_WRITTEN_TYPE = RECORD_WRITTEN_TYPE;
