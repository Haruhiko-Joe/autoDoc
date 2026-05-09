import { AsyncLocalStorage } from "node:async_hooks"

const projectLocks = new Map<string, Promise<void>>()
const heldProjects = new AsyncLocalStorage<Set<string>>()

export async function withDocProjectLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
  const held = heldProjects.getStore()
  if (held?.has(project)) return fn()

  while (projectLocks.has(project)) {
    await projectLocks.get(project)
  }

  let release: (() => void) | undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  projectLocks.set(project, current)

  const nextHeld = new Set(held ?? [])
  nextHeld.add(project)
  try {
    return await heldProjects.run(nextHeld, fn)
  } finally {
    if (projectLocks.get(project) === current) projectLocks.delete(project)
    if (release) release()
  }
}
