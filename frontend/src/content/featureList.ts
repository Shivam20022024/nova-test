export type FeatureListItem = {
  number: string
  title: string
  description: string
}

export const featureList: FeatureListItem[] = [
  {
    number: '001',
    title: 'Understand',
    description: 'Requirements, application objects, and workflows across your product',
  },
  {
    number: '002',
    title: 'Generate',
    description: 'AI designs test scenarios and TestIntent automatically',
  },
  {
    number: '003',
    title: 'Execute',
    description: 'Run tests at scale with self-healing automation',
  },
  {
    number: '004',
    title: 'Prove',
    description: 'Evidence-backed release decisions, every time',
  },
]
