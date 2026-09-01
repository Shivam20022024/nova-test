export type BuiltForCard = {
  icon: 'evidence' | 'systems' | 'progress'
  title: string
  description: string
}

export const builtForCards: BuiltForCard[] = [
  {
    icon: 'evidence',
    title: 'Evidence drives decisions',
    description:
      'We believe better releases start with better evidence — captured, traceable, and trusted.',
  },
  {
    icon: 'systems',
    title: 'Quality is a systems problem',
    description:
      'We build tools that connect requirements, tests, execution, and defects into one closed loop.',
  },
  {
    icon: 'progress',
    title: 'Progress over perfection',
    description:
      'We support real engineering velocity — helping teams ship from intention to verified quality.',
  },
]
