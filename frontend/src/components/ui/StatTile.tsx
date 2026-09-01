type StatTileProps = {
  label: string
  value: string | number
  unit?: string
}

export function StatTile({ label, value, unit }: StatTileProps) {
  return (
    <div className="rounded-md border border-line bg-paper-alt p-4">
      <p className="font-mono text-xs tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-3 font-sans text-2xl font-semibold text-ink">
        {value}
        {unit && <span className="ml-0.5 text-base font-medium text-ink-soft">{unit}</span>}
      </p>
    </div>
  )
}
