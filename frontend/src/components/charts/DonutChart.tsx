import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

export type DonutSlice = { label: string; value: number; color: string }

type DonutChartProps = {
  data: DonutSlice[]
  size?: number
  centerValue?: string | number
  centerLabel?: string
}

export function DonutChart({ data, size = 140, centerValue, centerLabel }: DonutChartProps) {
  const total = data.reduce((sum, slice) => sum + slice.value, 0)

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {total > 0 ? (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={size * 0.32}
              outerRadius={size * 0.48}
              startAngle={90}
              endAngle={-270}
              stroke="var(--color-paper-alt)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((slice) => (
                <Cell key={slice.label} fill={slice.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-full w-full rounded-full border border-dashed border-line" aria-hidden="true" />
      )}
      {(centerValue !== undefined || centerLabel) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          {centerValue !== undefined && <span className="font-serif text-xl text-ink">{centerValue}</span>}
          {centerLabel && <span className="font-mono text-[10px] tracking-wide text-muted uppercase">{centerLabel}</span>}
        </div>
      )}
    </div>
  )
}
