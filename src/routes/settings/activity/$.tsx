import { createFileRoute } from '@tanstack/react-router'
import { ActivityComponent } from './index.lazy'

export const Route = createFileRoute('/settings/activity/$')({
  component: ActivityComponent,
})
