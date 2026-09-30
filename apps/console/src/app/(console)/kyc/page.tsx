import Link from 'next/link';
import { api } from '@/lib/api';
import { ref, waited } from '@/lib/format';
import { Decision } from './Decision';

interface Row { id: string; role: string; verification_tier: number; target_tier: number; age_seconds: number }

export default async function KycQueue() {
  const { data } = await api.get<{ data: Row[] }>('/ops/kyc');
  return (
    <>
      <h1>KYC queue</h1>
      <p className="lede">Cases the vendor could not clear automatically. Documents open in a viewer that never leaves this console — nothing is downloadable.</p>
      {data.length === 0 ? <p className="empty">No cases waiting.</p> : (
        <table className="table">
          <thead><tr><th scope="col">Case</th><th scope="col">Tier</th><th scope="col">Applicant</th><th scope="col">Waiting</th><th scope="col" className="right">Decision</th></tr></thead>
          <tbody>
            {data.map((k) => (
              <tr key={k.id}>
                <td><Link href={`/kyc/${k.id}`}>{ref('KYC', k.id)}</Link></td>
                <td>tier {k.target_tier}</td>
                <td><span className="pill">{k.role === 'runner' ? 'Runner' : 'Requester'} · now tier {k.verification_tier}</span></td>
                <td className="muted">{waited(k.age_seconds)}</td>
                <td className="right"><Decision caseId={k.id} tier={k.target_tier} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
