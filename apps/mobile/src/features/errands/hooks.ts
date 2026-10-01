// apps/mobile/src/features/errands/hooks.ts
// Query keys per 05-ui-architecture §5.4: ['errand', id], ['errands', …], ['feed', …].
// staleTime 30s for lists, 0 for the live errand; every socket event has a polling twin.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ErrandDetail, ErrandSummary, FeedItem, BidsResponse, CreateErrand, Wallet, Earnings, Message, NearbyRunner, KycCase } from '@sidequest/contracts';
import { api, newIdemKey } from '../../lib/api';

export const errandKey = (id: string) => ['errand', id] as const;

export function useErrands(status: 'live' | 'open' | 'done' | 'all', role?: 'requester' | 'runner') {
  return useQuery({
    queryKey: ['errands', status, role],
    queryFn: () => api.get<{ data: ErrandSummary[] }>(`/errands?status=${status}${role ? `&role=${role}` : ''}`).then((r) => r.data),
    staleTime: 30_000,
    refetchInterval: status === 'live' ? 15_000 : false,
  });
}

export function useErrand(id: string | undefined, live = true) {
  return useQuery({
    queryKey: errandKey(id ?? 'none'),
    enabled: Boolean(id),
    queryFn: () => api.get<ErrandDetail>(`/errands/${id}`),
    staleTime: 0,
    // A dropped socket degrades to a 5-second poll on the active errand and nothing else.
    refetchInterval: live ? 5_000 : false,
  });
}

export function useBids(id: string, enabled: boolean) {
  return useQuery({ queryKey: ['bids', id], enabled, queryFn: () => api.get<BidsResponse>(`/errands/${id}/bids`), refetchInterval: 10_000 });
}

export function useNearby(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['nearby', id], enabled, staleTime: 60_000,
    queryFn: () => api.get<{ runners: NearbyRunner[] }>(`/runners/nearby?errand_id=${id}`).then((r) => r.runners),
  });
}

export function useFeed(pos: { lat: number; lng: number } | null) {
  return useQuery({
    queryKey: ['feed', pos?.lat.toFixed(3), pos?.lng.toFixed(3)],
    enabled: Boolean(pos),
    queryFn: () => api.get<{ data: FeedItem[] }>(`/feed?lat=${pos!.lat}&lng=${pos!.lng}`).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useWallet() {
  return useQuery({ queryKey: ['wallet'], queryFn: () => api.get<Wallet>('/wallet'), staleTime: 10_000 });
}
export function useEarnings() {
  return useQuery({ queryKey: ['earnings'], queryFn: () => api.get<Earnings>('/earnings'), staleTime: 10_000 });
}
export function useMessages(id: string) {
  return useQuery({ queryKey: ['messages', id], queryFn: () => api.get<{ data: Message[] }>(`/errands/${id}/messages`).then((r) => r.data), refetchInterval: 10_000 });
}
export function useKyc() {
  return useQuery({ queryKey: ['kyc'], queryFn: () => api.get<KycCase | null>('/kyc/cases/mine') });
}

/** A mutation that posts once per intent: the key is minted when the user acts, reused on retry. */
export function useAction<B = unknown, R = unknown>(path: (b: B) => string, invalidate: readonly (readonly unknown[])[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idem }: { body: B; idem?: string }) => api.post<R>(path(body), body, { idem: idem ?? newIdemKey() }),
    onSuccess: () => { for (const k of invalidate) qc.invalidateQueries({ queryKey: k }); qc.invalidateQueries({ queryKey: ['errands'] }); },
  });
}

export type { CreateErrand };
