import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { DisputeList, type DisputeRow } from './DisputeList';

export default async function Disputes() {
  const { data } = await api.get<{ data: DisputeRow[] }>('/ops/disputes');
  if (data[0]) redirect(`/disputes/${data[0].id}`);
  return <div className="split"><DisputeList rows={data} /></div>;
}
