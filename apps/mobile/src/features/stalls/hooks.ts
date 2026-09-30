// apps/mobile/src/features/stalls/hooks.ts
// Server state only. The approval mutation carries a stable idempotency key so a retry
// after a dropped connection cannot approve the same stall twice.

import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApproveResponse, ErrandDetail, Stall, Tranche } from '@sidequest/contracts';
import { api, isNetworkError, newIdemKey } from '../../lib/api';
import { errandKey } from '../errands/hooks';

/** One stall, read from the live errand aggregate (there is no per-stall endpoint in 04-api.md). */
export function useStall(errandId: string, stallId: string) {
  return useQuery({
    queryKey: errandKey(errandId),
    queryFn: () => api.get<ErrandDetail>(`/errands/${errandId}`),
    staleTime: 0,
    select: (e): { stall: Stall | undefined; errand: ErrandDetail } => ({ stall: e.stalls.find((s) => s.id === stallId), errand: e }),
  });
}

/** Stable for the life of this sheet: a retry reuses it, a fresh sheet gets a fresh one. */
function useStableKey(): string {
  const ref = useRef<string | null>(null);
  if (!ref.current) ref.current = newIdemKey();
  return ref.current;
}

export function useApproveStall(errandId: string, stallId: string) {
  const qc = useQueryClient();
  const idem = useStableKey();
  return useMutation({
    mutationKey: ['approve', errandId, stallId],
    retry: (count, err) => count < 3 && isNetworkError(err),
    mutationFn: () => api.post<ApproveResponse>(`/errands/${errandId}/stalls/${stallId}/approve`, {}, { idem }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: errandKey(errandId) }); },
  });
}

/**
 * Polls the tranche while it is pending. The WebSocket normally beats this; polling is the
 * floor, so a dropped socket costs the user two seconds rather than a stuck screen.
 */
export function useTrancheStatus(errandId: string, trancheId?: string) {
  return useQuery({
    queryKey: ['tranche', errandId, trancheId],
    enabled: Boolean(trancheId),
    queryFn: () => api.get<Tranche>(`/errands/${errandId}/tranches/${trancheId}`),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 2000 : false),
  });
}

export function useDeclineStall(errandId: string, stallId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => api.post(`/errands/${errandId}/stalls/${stallId}/decline`, { reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: errandKey(errandId) }); },
  });
}

export function useSubstitute(errandId: string, stallId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { line_item_id: string; label: string; qty: number; unit: string; price_cents: number }) =>
      api.post(`/errands/${errandId}/stalls/${stallId}/substitute`, b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: errandKey(errandId) }); },
  });
}

export function useReimbursement(errandId: string) {
  const qc = useQueryClient();
  const idem = useStableKey();
  return useMutation({
    mutationFn: (b: { tranche_id: string; accept: boolean }) => api.post(`/errands/${errandId}/reimbursement/confirm`, b, { idem }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: errandKey(errandId) }); },
  });
}
