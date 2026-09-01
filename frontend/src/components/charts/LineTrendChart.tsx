import { CartesianGrid, Line, LineChart, ResponsiveContainer, YAxis } from 'recharts'
import type { TrendPoint } from './types'

type LineTrendChartProps = {
  data: TrendPoint[]
  height?: number
  color?: string
  unit?: string
}

export function LineTrendChart({ data, height = 200, color = 'var(--color-accent)', unit = '' }: LineTrendChartProps) {
  const max = Math.max(...data.map((point) => point.value))
  const niceMax = Math.ceil((max * 1.15) / 10) * 10

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-line)" />
        <YAxis
          domain={[0, niceMax]}
          axisLine={false}
          tickLine={false}
          width={40}
          tick={{ fill: 'var(--color-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
          tickFormatter={(value: number) => `${value}${unit}`}
        />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
