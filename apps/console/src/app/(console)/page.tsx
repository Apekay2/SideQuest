import { redirect } from 'next/navigation';
import { can, officer } from '@/lib/api';

export default async function Home() {
  const who = await officer();
  if (can(who, 'ops.read')) redirect('/disputes');
  if (can(who, 'kyc.review')) redirect('/kyc');
  return (
    <>
      <h1>Nothing to review</h1>
      <p className="lede">Your account has no console queues assigned. Ask the system administrator for the entitlements your role needs.</p>
    </>
  );
}
