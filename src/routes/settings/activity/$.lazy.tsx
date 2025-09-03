import { createLazyFileRoute } from '@tanstack/react-router'

export const Route = createLazyFileRoute('/settings/activity/$')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/settings/activity/$"!</div>
}
