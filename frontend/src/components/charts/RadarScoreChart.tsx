import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer } from 'recharts'

export type RadarPoint = { label: string; value: number }

type RadarScoreChartProps = {
  data: RadarPoint[]
  height?: number
  color?: string
}

export function RadarScoreChart({ data, height = 200, color = 'var(--color-accent)' }: RadarScoreChartProps) {
  const tick = { fill: 'var(--color-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadarChart data={data} outerRadius="58%" margin={{ top: 16, right: 36, bottom: 16, left: 36 }}>
        <PolarGrid stroke="var(--color-line)" />
        <PolarAngleAxis dataKey="label" tick={tick} />
        <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} tickCount={3} />
        <Radar
          dataKey="value"
          stroke={color}
          fill={color}
          fillOpacity={0.2}
          strokeWidth={2}
          isAnimationActive={false}
        />
      </RadarChart>
    </ResponsiveContainer>
  )
}
