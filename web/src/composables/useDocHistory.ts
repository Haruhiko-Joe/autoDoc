import { ref, type Ref } from 'vue'
import { fetchHistory, fetchHistoryDiff } from '../services/doc'

export interface VersionEntry {
  version: number
  ts: string
  source?: { type: string; ref?: string }
  summary?: string
}

export function useDocHistory(project: Ref<string>, relPath: Ref<string>) {
  const versions = ref<VersionEntry[]>([])
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      const data = await fetchHistory(project.value, relPath.value)
      versions.value = data.versions
    } catch {
      versions.value = []
    } finally {
      loading.value = false
    }
  }

  async function diff(vA: number, vB: number): Promise<{ contentA: string; contentB: string }> {
    return fetchHistoryDiff(project.value, relPath.value, vA, vB)
  }

  return { versions, loading, load, diff }
}
