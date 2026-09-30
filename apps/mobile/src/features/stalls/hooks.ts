// apps/mobile/src/features/stalls/hooks.ts
// Server state only. The approval mutation carries a stable idempotency key so a retry
// after a dropped connection cannot approve the same stall twice.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { StallDetail, TrancheStatus, ApproveResponse } from '@sidequest/contracts';

const stallKey = (errandId: string, stallId: string) => ['stall', errandId, stallId] as const;
const trancheKey = (errandId: string, trancheId?: string) => ['tranche', errandId, trancheId] as const;

export function useStall(errandId: string, stallId: string) {
  return useQuery({
    queryKey: stallKey(errandId, stallId),
    queryFn: () => api.get<StallDetail>(`/errands/${errandId}/stalls/${stallId}`),
    staleTime: 0,
  });
}

export function useApproveStall(errandId: string, stallId: string) {
  const qc = useQueryClient();
  // Stable for the life of this sheet: a retry reuses it, a fresh sheet gets a fresh one.
  const idemKey = useStableUuid(`approve:${errandId}:${stallId}`);

  return useMutation({
    mutationKey: ['approve', errandId, stallId],
    retry: (count, err) => count < 3 && isNetworkError(err),
    mutationFn: () =>
      api.post<ApproveResponse>(
        `/errands/${errandId}/stalls/${stallId}/approve`,
        undefined,
        { headers: { 'Idempotency-Key': idemKey } },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['errand', errandId] });
      qc.invalidateQueries({ queryKey: stallKey(errandId, stallId) });
    },
  });
}

/**
 * Polls the tranche while it is pending. The WebSocket normally beats this; polling is the
 * floor, so a dropped socket costs the user two seconds rather than a stuck screen.
 */
export function useTrancheStatus(errandId: string, trancheId?: string) {
  return useQuery({
    queryKey: trancheKey(errandId, trancheId),
    enabled: Boolean(trancheId),
    queryFn: () => api.get<TrancheStatus>(`/errands/${errandId}/tranches/${trancheId}`),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 2000 : false),
  });
}

import { useRef } from 'react';
import * as Crypto from 'expo-crypto';

function useStableUuid(seed: string): string {
  const ref = useRef<string>();
  if (!ref.current) ref.current = `${seed}:${Crypto.randomUUID()}`;
  return ref.current;
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err as { status?: number })?.status === undefined;
}
