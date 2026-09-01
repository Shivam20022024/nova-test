import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, XAxis, YAxis } from 'recharts'

export type CategoryPoint = { label: string; value: number; color?: string }

type CategoryBarChartProps = {
  data: CategoryPoint[]
  height?: number
  layout?: 'vertical' | 'horizontal'
}

export function CategoryBarChart({ data, height = 200, layout = 'horizontal' }: CategoryBarChartProps) {
  const tick = { fill: 'var(--color-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }

  if (layout === 'vertical') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid horizontal={false} stroke="var(--color-line)" />
          <XAxis type="number" axisLine={false} tickLine={false} tick={tick} />
          <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} width={90} tick={tick} />
          <Bar dataKey="value" radius={[0, 3, 3, 0]} maxBarSize={16}>
            {data.map((point) => (
              <Cell key={point.label} fill={point.color ?? 'var(--color-ink)'} fillOpacity={point.color ? 1 : 0.82} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-line)" />
        <XAxis dataKey="label" axisLine={false} tickLine={false} tick={tick} />
        <YAxis axisLine={false} tickLine={false} width={32} tick={tick} />
        <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={28}>
          {data.map((point) => (
            <Cell key={point.label} fill={point.color ?? 'var(--color-ink)'} fillOpacity={point.color ? 1 : 0.82} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
