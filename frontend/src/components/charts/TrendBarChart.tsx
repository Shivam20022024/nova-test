import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, YAxis } from 'recharts'
import type { TrendPoint } from './types'

type TrendBarChartProps = {
  data: TrendPoint[]
  height?: number
}

type PeakLabelProps = {
  x?: number | string
  y?: number | string
  width?: number | string
  index?: number
}

function makePeakLabel(data: TrendPoint[]) {
  return ({ x = 0, y = 0, width = 0, index }: PeakLabelProps) => {
    const point = typeof index === 'number' ? data[index] : undefined
    if (!point?.highlight) return null

    const cx = Number(x) + Number(width) / 2
    const cy = Number(y)
    return (
      <g transform={`translate(${cx}, ${cy - 16})`}>
        <rect x={-22} y={-13} width={44} height={22} rx={11} fill="var(--color-accent)" />
        <text
          x={0}
          y={3}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize={11}
          fontWeight={600}
          fill="var(--color-accent-ink)"
        >
          {point.value}
        </text>
      </g>
    )
  }
}

export function TrendBarChart({ data, height = 220 }: TrendBarChartProps) {
  const max = Math.max(...data.map((point) => point.value))
  const niceMax = Math.ceil(max / 40) * 40 + 20

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 26, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-line)" />
        <YAxis
          domain={[0, niceMax]}
          ticks={[Math.round(niceMax / 2 / 20) * 20, Math.round((niceMax - 20) / 20) * 20]}
          axisLine={false}
          tickLine={false}
          width={36}
          tick={{ fill: 'var(--color-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
        />
        <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={14} label={makePeakLabel(data)}>
          {data.map((point) => (
            <Cell
              key={point.label}
              fill={point.highlight ? 'var(--color-accent)' : 'var(--color-ink)'}
              fillOpacity={point.highlight ? 1 : 0.82}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
