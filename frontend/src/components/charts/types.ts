/** A single point on the small trend charts. */
export type TrendPoint = {
  label: string
  value: number
  /** Marks the peak so the bar chart can annotate it. */
  highlight?: boolean
}
