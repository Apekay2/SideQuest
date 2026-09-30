// apps/mobile/src/screens/StallApproval/StallApprovalSheet.tsx
// The money screen. Approvals are never optimistic: the button stays in a loading state
// until the server acknowledges, and the sheet only closes on `tranche.loaded`.

import React, { useMemo } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Image } from 'react-native';
import { useT } from '../../i18n/useT';
import { tokens as t } from '../../theme/tokens';
import { formatKes } from '@sidequest/domain/money/money';
import { useStall, useApproveStall, useTrancheStatus } from '../../features/stalls/hooks';
import { LadderState } from './LadderState';

interface Props {
  errandId: string;
  stallId: string;
  onClose: () => void;
}

export function StallApprovalSheet({ errandId, stallId, onClose }: Props) {
  const T = useT();
  const { data: stall, isLoading } = useStall(errandId, stallId);
  const approve = useApproveStall(errandId, stallId);
  const tranche = useTrancheStatus(errandId, approve.data?.tranche.id);

  const overCap = useMemo(
    () => (stall ? stall.total_cents > stall.remaining_cap_cents : false),
    [stall],
  );

  React.useEffect(() => {
    if (tranche.data?.status === 'loaded') onClose();
  }, [tranche.data?.status, onClose]);

  if (isLoading || !stall) {
    return (
      <View style={{ padding: 40, alignItems: 'center' }}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }

  if (tranche.data?.status === 'failed') {
    return <LadderState errandId={errandId} trancheId={tranche.data.id} onClose={onClose} />;
  }

  const pending = approve.isPending || tranche.data?.status === 'pending';

  return (
    <View style={{ backgroundColor: t.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingBottom: 28 }}>
      <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 999, backgroundColor: t.border, marginTop: 10 }} />

      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ fontFamily: t.fontHeading, fontSize: 17, color: t.text }}>{stall.name}</Text>
        <Text style={{ fontSize: 12, color: t.textFaint, marginTop: 2 }}>
          {T('stall.of', { seq: stall.seq, total: stall.stall_count })}
        </Text>

        {stall.photo_url ? (
          <Image
            source={{ uri: stall.photo_url }}
            style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 26, marginTop: 14, backgroundColor: t.surfaceSunk }}
            resizeMode="cover"
          />
        ) : null}

        <View style={{ marginTop: 16, gap: 8 }}>
          {stall.items.map((item) => (
            <View
              key={item.id}
              style={{
                backgroundColor: t.surfaceSunk, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 14,
                flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13.5, color: t.text }}>{item.label}</Text>
                <Text style={{ fontSize: 12, color: t.textMuted, marginTop: 1 }}>
                  {item.qty} {T(`unit.${item.unit}`)}
                </Text>
                {item.substituted_for_label ? (
                  <Text style={{ fontSize: 11, color: t.accent2, marginTop: 3 }}>
                    {T('stall.substituted', { original: item.substituted_for_label })}
                  </Text>
                ) : null}
              </View>
              <Text style={{ fontSize: 13.5, color: t.text, fontVariant: ['tabular-nums'] }}>
                {formatKes(item.price_cents, T.locale)}
              </Text>
            </View>
          ))}
        </View>

        <View style={{ marginTop: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase', color: t.textFaint }}>
              {T('stall.total')}
            </Text>
            <Text style={{ fontFamily: t.fontHeading, fontSize: 22, color: overCap ? t.accentDeep : t.text }}>
              {formatKes(stall.total_cents, T.locale)}
            </Text>
          </View>
          <Text style={{ fontSize: 12, color: t.textFaint, marginBottom: 4 }}>
            {T('stall.remaining', { amount: formatKes(stall.remaining_cap_cents, T.locale) })}
          </Text>
        </View>

        {overCap ? (
          <View style={{ marginTop: 12, backgroundColor: t.accentTint, borderWidth: 1, borderColor: t.accentEdge, borderRadius: 20, padding: 13 }}>
            <Text style={{ fontSize: 13, color: t.accentDeep, lineHeight: 19 }}>
              {T('stall.over_cap', {
                over: formatKes(stall.total_cents - stall.remaining_cap_cents, T.locale),
              })}
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: overCap || pending, busy: pending }}
          disabled={overCap || pending}
          onPress={() => approve.mutate()}
          style={({ pressed }) => ({
            marginTop: 16, minHeight: 52, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
            backgroundColor: overCap ? t.border : pressed ? t.accent : t.accentDeep,
            opacity: pending ? 0.75 : 1,
          })}
        >
          {pending ? (
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <ActivityIndicator color={t.accentTint} />
              <Text style={{ fontFamily: t.fontHeading, fontSize: 15, color: t.accentTint }}>
                {T('stall.loading_card')}
              </Text>
            </View>
          ) : (
            <Text style={{ fontFamily: t.fontHeading, fontSize: 15, color: overCap ? t.textMuted : t.accentTint }}>
              {T('stall.approve', { amount: formatKes(stall.total_cents, T.locale) })}
            </Text>
          )}
        </Pressable>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <SecondaryAction label={T('stall.substitute')} onPress={() => approve.reset()} disabled={pending} />
          <SecondaryAction label={T('stall.decline')} onPress={onClose} disabled={pending} />
        </View>
      </ScrollView>
    </View>
  );
}

function SecondaryAction({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1, minHeight: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: t.border,
        backgroundColor: pressed ? t.surfaceSunk : 'transparent',
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Text style={{ fontSize: 13.5, color: t.textMuted }}>{label}</Text>
    </Pressable>
  );
}
