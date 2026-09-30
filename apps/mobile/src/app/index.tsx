import { Redirect } from 'expo-router';
import { useSession } from '../lib/session';

export default function Index() {
  const account = useSession((s) => s.account);
  if (!account) return <Redirect href="/sign-in" />;
  return <Redirect href={account.role === 'runner' ? '/feed' : '/home'} />;
}
