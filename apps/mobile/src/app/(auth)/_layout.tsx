import { Stack } from 'expo-router/stack';
import { tokens as t } from '../../theme/tokens';
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />;
}
