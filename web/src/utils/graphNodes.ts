import type { EdgeType, GraphEdge, GraphNode } from '../types'

export interface NodeFormData {
  name: string
  description: string
  codeScope: string[]
  childType: 'graph' | 'page'
  childRef: string
}

export interface EdgeFormData {
  target: string
  type: EdgeType
  description: string
}

export type EdgeIdentity = Pick<GraphEdge, 'target' | 'type'>

export function cloneGraphNodes(nodes: GraphNode[]): GraphNode[] {
  const cloned = nodes.map((node) => ({
    ...node,
    codeScope: [...node.codeScope],
    edges: node.edges.map((edge) => ({ ...edge })),
    child: { ...node.child },
  }))
  return cloned
}

export function filterGraphNodes(nodes: GraphNode[], selectedNames: string[] | null): GraphNode[] {
  if (selectedNames === null) return nodes

  const visibleNames = new Set(selectedNames)
  return nodes
    .filter((node) => visibleNames.has(node.name))
    .map((node) => ({
      ...node,
      edges: node.edges.filter((edge) => visibleNames.has(edge.target)),
    }))
}

export function pruneSelectedNodeNames(selectedNames: string[] | null, nodeNames: string[]): string[] | null {
  if (selectedNames === null) return null

  const existingNames = new Set(nodeNames)
  const next = selectedNames.filter((name) => existingNames.has(name))
  return next.length ? next : null
}

export function createGraphNode(data: NodeFormData, forceGraphChild: boolean): GraphNode | null {
  const name = data.name.trim()
  if (!name) return null

  return {
    name,
    description: data.description,
    codeScope: [...data.codeScope],
    edges: [],
    child: forceGraphChild
      ? { type: 'graph', ref: name }
      : { type: data.childType, ref: data.childRef || name },
  }
}

export function updateGraphNode(
  nodes: GraphNode[],
  oldName: string,
  data: NodeFormData,
  forceGraphChild: boolean,
): GraphNode[] {
  const name = data.name.trim()
  if (!name) return nodes

  return nodes.map((node) => {
    const nextNode: GraphNode = node.name === oldName
      ? {
          ...node,
          name,
          description: data.description,
          codeScope: [...data.codeScope],
          child: forceGraphChild ? { type: 'graph', ref: name } : node.child,
        }
      : node

    return {
      ...nextNode,
      edges: nextNode.edges.map((edge) =>
        edge.target === oldName ? { ...edge, target: name } : edge,
      ),
    }
  })
}

export function removeGraphNode(nodes: GraphNode[], name: string): GraphNode[] {
  const remainingNodes = nodes
    .filter((node) => node.name !== name)
    .map((node) => ({
      ...node,
      edges: node.edges.filter((edge) => edge.target !== name),
    }))
  return remainingNodes
}

export function upsertEdge(edges: GraphEdge[], current: EdgeIdentity | undefined, data: EdgeFormData): GraphEdge[] {
  const nextEdge: GraphEdge = {
    target: data.target,
    type: data.type,
    description: data.description,
  }

  if (!current) return [...edges, nextEdge]

  return edges.map((edge) =>
    edge.target === current.target && edge.type === current.type ? nextEdge : edge,
  )
}

export function removeEdge(edges: GraphEdge[], target: string, type: EdgeType): GraphEdge[] {
  const remainingEdges = edges.filter((edge) => !(edge.target === target && edge.type === type))
  return remainingEdges
}

export function updateNodeEdges(
  nodes: GraphNode[],
  source: string,
  update: (edges: GraphEdge[]) => GraphEdge[],
): GraphNode[] {
  const nextNodes = nodes.map((node) =>
    node.name === source ? { ...node, edges: update(node.edges) } : node,
  )
  return nextNodes
}

export function normalizeGraphNodes(nodes: GraphNode[], forceGraphChild: boolean): GraphNode[] {
  const normalized = nodes.map((node) => {
    const name = node.name.trim()
    const child: GraphNode['child'] = forceGraphChild
      ? { type: 'graph', ref: name }
      : { type: node.child.type, ref: node.child.ref.trim() || name }

    return {
      name,
      description: node.description.trim(),
      codeScope: node.codeScope.map((item) => item.trim()).filter(Boolean),
      edges: node.edges.map((edge) => ({
        target: edge.target,
        type: edge.type,
        description: edge.description.trim(),
        detail: edge.detail,
      })),
      child,
    }
  })
  return normalized
}
