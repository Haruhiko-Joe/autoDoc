import type { TopGraph, SubGraph, FlowsData } from '../types'

const BASE = '/autoDoc/doc/'

function docUrl(project: string, filePath: string): string {
  return `${BASE}${project}/${filePath}`
}

export async function fetchTopGraph(project: string): Promise<TopGraph> {
  const res = await fetch(docUrl(project, 'top.json'))
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchSubGraph(project: string, ref: string): Promise<SubGraph> {
  const name = ref.split('/').pop()
  const res = await fetch(docUrl(project, `${ref}/${name}.json`))
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchPage(project: string, ref: string): Promise<string> {
  const res = await fetch(docUrl(project, `${ref}.md`))
  if (!res.ok) throw new Error(await res.text())
  return res.text()
}

export async function fetchFlows(project: string): Promise<FlowsData> {
  const res = await fetch(docUrl(project, 'flows.json'))
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface SearchResult {
  name: string
  description: string
  path: string
  type: 'graph' | 'page'
}

export async function fetchProjects(): Promise<string[]> {
  const res = await fetch(`${BASE}projects.json`)
  if (!res.ok) return []
  const data = await res.json() as { projects?: string[] }
  return data.projects ?? []
}
