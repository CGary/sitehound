/**
 * The envelope is the only thing allowed on stdout. Importing this module captures the real stdout
 * writer; `guardStdout()` then reroutes every other writer (console.log, task code, libraries) to stderr.
 */
const realWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;

export function guardStdout(): void {
  const toStderr = ((chunk: unknown, encoding?: unknown, cb?: unknown) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, encoding, cb)) as typeof process.stdout.write;
  process.stdout.write = toStderr;
}

/** Writes to the real stdout and resolves once flushed. */
export function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => {
    realWrite(text, () => resolve());
  });
}

/** Writes to the real stdout without waiting (pipes, files and TTYs are synchronous on POSIX). For exit paths. */
export function writeStdoutNow(text: string): void {
  realWrite(text);
}

export function writeStderr(text: string): void {
  process.stderr.write(text);
}
