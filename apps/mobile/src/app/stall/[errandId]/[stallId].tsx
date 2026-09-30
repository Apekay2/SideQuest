import { useCallback } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StallApprovalSheet } from '../../../screens/StallApproval/StallApprovalSheet';

export default function StallApprovalRoute() {
  const { errandId, stallId } = useLocalSearchParams<{ errandId: string; stallId: string }>();
  const close = useCallback(() => { if (router.canGoBack()) router.back(); else router.replace(`/errand/${errandId}`); }, [errandId]);
  return <StallApprovalSheet errandId={errandId} stallId={stallId} onClose={close} />;
}
