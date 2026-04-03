import type { EdgeType } from '../types'

export interface EdgeVisual {
  stroke: string
  lineDash?: number[]
  endArrowType: string
  label: string
}

export const EDGE_STYLES: Record<EdgeType, EdgeVisual> = {
  calls: {
    stroke: '#1890ff',
    label: 'calls',
    endArrowType: 'triangle',
  },
  depends: {
    stroke: '#faad14',
    lineDash: [6, 4],
    label: 'depends',
    endArrowType: 'triangle',
  },
  'data-flow': {
    stroke: '#52c41a',
    label: 'data-flow',
    endArrowType: 'triangle',
  },
  event: {
    stroke: '#eb2f96',
    lineDash: [2, 4],
    label: 'event',
    endArrowType: 'triangle',
  },
  extends: {
    stroke: '#722ed1',
    label: 'extends',
    endArrowType: 'vee',
  },
  composes: {
    stroke: '#13c2c2',
    label: 'composes',
    endArrowType: 'diamond',
  },
}
