export type PreviewMetric = {
  label: string
  value: string
  meta: string
  metaTop?: string
  highlight?: boolean
}

export const commandCenterPreview: {
  greeting: string
  subGreeting: string
  metrics: PreviewMetric[]
} = {
  greeting: 'Good morning, Novalantis',
  subGreeting: 'Your release confidence is ready to review.',
  metrics: [
    {
      label: 'Tests passed',
      value: '1,420',
      meta: '98%',
    },
    {
      label: 'Avg run time',
      value: '4m 12s',
      meta: '↓12.4%',
    },
    {
      label: 'Release confidence',
      value: '92',
      metaTop: '/100',
      meta: 'High Confidence',
      highlight: true,
    },
  ],
}
