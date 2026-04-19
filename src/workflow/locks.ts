const projectLocks = new Map<string, Promise<void>>();

export async function withProjectLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
  while (projectLocks.has(project)) {
    await projectLocks.get(project);
  }
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  projectLocks.set(project, p);
  try {
    return await fn();
  } finally {
    projectLocks.delete(project);
    resolve();
  }
}
