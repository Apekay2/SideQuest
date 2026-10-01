import Link from 'next/link';
import { api } from '@/lib/api';
import { ref, when } from '@/lib/format';
import { Decision } from '../Decision';
import { Photo } from '../../Photo';

interface Case {
  id: string; display_name: string; target_tier: number; status: string; created_at: string; movement_consent: boolean;
  documents: Record<'id_front' | 'id_back' | 'selfie' | 'conduct_cert', string | null>;
  id_number_masked: string | null; next_of_kin: { name: string; msisdn_masked: string } | null;
}

const SLOTS = [['id_front', 'ID, front'], ['id_back', 'ID, back'], ['selfie', 'Selfie'], ['conduct_cert', 'Certificate of good conduct']] as const;

// Opening this page writes a kyc.view audit row (the API does it on read).
export default async function KycCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await api.get<Case>(`/ops/kyc/${encodeURIComponent(id)}`);
  const open = c.status === 'submitted' || c.status === 'in_review';
  return (
    <>
      <p><Link href="/kyc">← KYC queue</Link></p>
      <h1>{ref('KYC', c.id)}</h1>
      <p className="lede">{c.display_name} · asking for tier {c.target_tier} · submitted {when(c.created_at)}. Links to these documents expire in two minutes; reload to see them again.</p>
      <div className="docs">
        {SLOTS.map(([slot, label]) => (
          <Photo key={slot} src={c.documents[slot]} caption={label} missing={slot === 'conduct_cert' && c.target_tier < 3 ? 'Not needed below tier 3' : 'Not provided'} />
        ))}
      </div>
      <div className="eyebrow">Details</div>
      <dl className="facts">
        <dt>ID number</dt><dd>{c.id_number_masked ?? 'Not given'}</dd>
        <dt>Next of kin</dt><dd>{c.next_of_kin ? `${c.next_of_kin.name} · ${c.next_of_kin.msisdn_masked}` : 'Not given'}</dd>
        <dt>Location consent</dt><dd>{c.movement_consent ? 'Given' : 'Not given'}</dd>
        <dt>Status</dt><dd>{c.status.replace('_', ' ')}</dd>
      </dl>
      <div className="eyebrow">Decision</div>
      {open ? <Decision caseId={c.id} tier={c.target_tier} align="start" /> : <p className="muted">This case has been decided.</p>}
    </>
  );
}
