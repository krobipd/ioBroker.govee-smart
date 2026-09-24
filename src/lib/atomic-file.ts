import * as fs from "node:fs";

/** In-flight write per file — a second write of the same file queues behind the first. */
const chains = new Map<string, Promise<void>>();

/**
 * Write a file so that a crash mid-write never leaves a torn one behind:
 * the data goes to `<file>.tmp`, is flushed to the disk (`fsync` — plain
 * `writeFile` only reaches the page cache, and a SIGKILL inside the writeback
 * window would lose it silently) and is renamed into place. Writes of the
 * same file are serialised, so two callers never share the temp file.
 *
 * `mode` is applied when the temp file is created and survives the rename —
 * a credentials file stays owner-only on every write.
 *
 * @param file Target path
 * @param data Content (UTF-8)
 * @param mode File mode of a newly created file, e.g. `0o600`
 */
export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  const write = async (): Promise<void> => {
    const tmp = `${file}.tmp`;
    const handle = await fs.promises.open(tmp, "w", mode);
    try {
      await handle.writeFile(data, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, file);
  };
  const previous = chains.get(file) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(write);
  chains.set(file, current);
  try {
    await current;
  } finally {
    if (chains.get(file) === current) {
      chains.delete(file);
    }
  }
}
