import type { TrendPoint } from '../components/charts/types'

/**
 * Illustrative figures for the product-preview card on the public landing
 * page. This is marketing artwork, not application data - the in-app trend
 * chart reads real numbers from /api/v1/dashboard/execution-trend.
 */
export const previewExecutionsTrend: TrendPoint[] = [
  { label: 'Feb 2', value: 118 },
  { label: 'Feb 9', value: 126 },
  { label: 'Feb 16', value: 134 },
  { label: 'Feb 23', value: 142 },
  { label: 'Mar 2', value: 150 },
  { label: 'Mar 9', value: 162 },
  { label: 'Mar 16', value: 176 },
  { label: 'Mar 23', value: 188 },
  { label: 'Mar 30', value: 202 },
  { label: 'Apr 6', value: 214 },
  { label: 'Apr 13', value: 224 },
  { label: 'Apr 20', value: 232, highlight: true },
  { label: 'Apr 27', value: 220 },
  { label: 'May 4', value: 206 },
  { label: 'May 11', value: 190 },
  { label: 'May 18', value: 174 },
  { label: 'May 25', value: 158 },
  { label: 'Jun 1', value: 144 },
  { label: 'Jun 8', value: 130 },
  { label: 'Jun 15', value: 120 },
]
