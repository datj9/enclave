import { ListSkeleton } from '@app/_components/list-skeleton'

export default function TrashLoading() {
  return <ListSkeleton label="Loading trash" rows={3} />
}
