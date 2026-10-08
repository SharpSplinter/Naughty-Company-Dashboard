import { createFileRoute } from '@tanstack/react-router'
import { FloorApp } from '../components/floor/floor-app'

export const Route = createFileRoute('/')({
  component: FloorApp,
})
