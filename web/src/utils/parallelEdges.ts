import { BaseEdge, ExtensionCategory, getExtension, register } from '@antv/g6'
import type { BaseEdgeStyleProps, Node, PathArray, Point } from '@antv/g6'

export const PARALLEL_LINE_EDGE_TYPE = 'parallel-line'

export type ParallelEdge = {
  id?: string
  source: string
  target: string
  data: { parallelOffset: number }
}

type Point2 = [number, number]

interface RectBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function getRectBounds(node: Node): RectBounds {
  const bounds = node.getShape('key').getBounds()
  return {
    minX: bounds.min[0],
    minY: bounds.min[1],
    maxX: bounds.max[0],
    maxY: bounds.max[1],
  }
}

// 0.5px tolerance accounts for anti-aliasing at node boundaries
const BOUNDS_EPSILON = 0.5
const DIRECTION_EPSILON = 1e-6

function nearestRectIntersection(
  bounds: RectBounds,
  originX: number,
  originY: number,
  dx: number,
  dy: number,
): Point2 | null {
  let bestT = Infinity
  let bestX = 0
  let bestY = 0

  if (Math.abs(dx) > DIRECTION_EPSILON) {
    for (const x of [bounds.minX, bounds.maxX]) {
      const t = (x - originX) / dx
      if (t < -DIRECTION_EPSILON || t >= bestT) continue
      const y = originY + t * dy
      if (y >= bounds.minY - BOUNDS_EPSILON && y <= bounds.maxY + BOUNDS_EPSILON) {
        bestT = t
        bestX = x
        bestY = y
      }
    }
  }

  if (Math.abs(dy) > DIRECTION_EPSILON) {
    for (const y of [bounds.minY, bounds.maxY]) {
      const t = (y - originY) / dy
      if (t < -DIRECTION_EPSILON || t >= bestT) continue
      const x = originX + t * dx
      if (x >= bounds.minX - BOUNDS_EPSILON && x <= bounds.maxX + BOUNDS_EPSILON) {
        bestT = t
        bestX = x
        bestY = y
      }
    }
  }

  return bestT < Infinity ? [bestX, bestY] : null
}

export function assignParallelEdgeOffsets<T extends ParallelEdge>(edges: T[], gap: number): void {
  const pairMap = new Map<string, T[]>()

  for (const edge of edges) {
    edge.data.parallelOffset = 0
    const key = edge.source < edge.target
      ? `${edge.source}|${edge.target}`
      : `${edge.target}|${edge.source}`
    const group = pairMap.get(key)
    if (group) group.push(edge)
    else pairMap.set(key, [edge])
  }

  for (const group of pairMap.values()) {
    if (group.length < 2) continue

    group.sort((a, b) => {
      const cmp = a.source.localeCompare(b.source)
      if (cmp !== 0) return cmp
      const cmp2 = a.target.localeCompare(b.target)
      if (cmp2 !== 0) return cmp2
      return (a.id ?? '').localeCompare(b.id ?? '')
    })
    const center = (group.length - 1) / 2

    group.forEach((edge, index) => {
      const laneOffset = (index - center) * gap
      edge.data.parallelOffset = edge.source <= edge.target ? laneOffset : -laneOffset
    })
  }
}

class ParallelLineEdge extends BaseEdge {
  protected getKeyPath(attributes: Required<BaseEdgeStyleProps>): PathArray {
    const parallelOffset = (attributes as Record<string, unknown>).parallelOffset as number | undefined ?? 0

    if (!parallelOffset) {
      const [sourcePoint, targetPoint] = this.getEndpoints(attributes)
      return [
        ['M', sourcePoint[0], sourcePoint[1]],
        ['L', targetPoint[0], targetPoint[1]],
      ]
    }

    const sourceNode = this.sourceNode
    const targetNode = this.targetNode
    const sourceCenter = sourceNode.getCenter() as unknown as Point
    const targetCenter = targetNode.getCenter() as unknown as Point
    const scx = sourceCenter[0], scy = sourceCenter[1]
    const tcx = targetCenter[0], tcy = targetCenter[1]
    const dx = tcx - scx
    const dy = tcy - scy
    const length = Math.hypot(dx, dy)

    if (!length) {
      const [sourcePoint, targetPoint] = this.getEndpoints(attributes)
      return [
        ['M', sourcePoint[0], sourcePoint[1]],
        ['L', targetPoint[0], targetPoint[1]],
      ]
    }

    const offsetX = (-dy / length) * parallelOffset
    const offsetY = (dx / length) * parallelOffset

    const sourcePoint = nearestRectIntersection(
      getRectBounds(sourceNode),
      scx + offsetX, scy + offsetY,
      dx, dy,
    )
    const targetPoint = nearestRectIntersection(
      getRectBounds(targetNode),
      tcx + offsetX, tcy + offsetY,
      -dx, -dy,
    )

    const sx = sourcePoint ? sourcePoint[0] : scx + offsetX
    const sy = sourcePoint ? sourcePoint[1] : scy + offsetY
    const tx = targetPoint ? targetPoint[0] : tcx + offsetX
    const ty = targetPoint ? targetPoint[1] : tcy + offsetY

    return [
      ['M', sx, sy],
      ['L', tx, ty],
    ]
  }
}

export function ensureParallelLineEdgeRegistered(): void {
  if (getExtension(ExtensionCategory.EDGE, PARALLEL_LINE_EDGE_TYPE)) return

  register(ExtensionCategory.EDGE, PARALLEL_LINE_EDGE_TYPE, ParallelLineEdge)
}
