// apps/mobile/src/components/ConfirmDestructive.tsx
// Section 3 of the parity design. A destructive confirm is the clearest case for letting each
// platform be itself:
//   iOS      action sheet from the bottom, within thumb reach. Message above the options,
//            destructive option in accentDeep (not system red), Cancel in its own group.
//   Android  centred M3 dialog: question as headline, body, actions bottom-right with the
//            confirming action last.
// Not negotiable on either (enforced here, not at call sites): nothing destructive is the
// default focused action, and the scrim does not dismiss.

import { Modal, Pressable, Text, View } from 'react-native';
import { tokens as t } from '../theme/tokens';
import { confirmPresentation, metrics, useSystemBack, haptic } from '../platform/adaptive';

export interface ConfirmProps {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  alternativeLabel?: string;
  onConfirm: () => void;
  onAlternative?: () => void;
  onCancel: () => void;
}

export function ConfirmDestructive(p: ConfirmProps) {
  useSystemBack(() => { if (p.visible) { p.onCancel(); return true; } return false; });
  if (!p.visible) return null;
  const confirm = () => { haptic.problem(); p.onConfirm(); };

  if (confirmPresentation.kind === 'action-sheet') {
    return (
      <Modal transparent visible animationType="fade" onRequestClose={p.onCancel}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: t.scrimConfirm }}>
          {/* The scrim is inert by design: no onPress. */}
          <View style={{ paddingHorizontal: 8, paddingBottom: 42, gap: 8 }}>
            <View style={{ backgroundColor: 'rgba(249,244,237,0.96)', borderRadius: 22, overflow: 'hidden' }}>
              <View style={{ paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: t.borderSoft }}>
                <Text accessibilityRole="text" style={{ fontFamily: t.fontBody, fontSize: 13, lineHeight: 19.5, color: t.textMuted, textAlign: 'center' }}>{p.body}</Text>
              </View>
              <SheetOption label={p.confirmLabel} color={t.accentDeep} bold onPress={confirm} divider={Boolean(p.alternativeLabel)} />
              {p.alternativeLabel && p.onAlternative ? <SheetOption label={p.alternativeLabel} color={t.textBody} onPress={p.onAlternative} /> : null}
            </View>
            <View style={{ backgroundColor: 'rgba(249,244,237,0.96)', borderRadius: 22, overflow: 'hidden' }}>
              <SheetOption label={p.cancelLabel} color={t.text} bold onPress={p.onCancel} />
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal transparent visible animationType="fade" onRequestClose={p.onCancel}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: t.scrimConfirm }}>
        <View accessibilityViewIsModal style={{ backgroundColor: t.surface, borderRadius: 28, padding: 24, width: '100%' }}>
          <Text accessibilityRole="header" style={{ fontFamily: t.fontHeading, fontSize: 22, lineHeight: 27.5, color: t.text }}>{p.title}</Text>
          <Text style={{ fontFamily: t.fontBody, fontSize: 14, lineHeight: 22.4, color: t.textBody, marginTop: 12 }}>{p.body}</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}>
            <DialogAction label={p.cancelLabel} onPress={p.onCancel} />
            <DialogAction label={p.confirmLabel} onPress={confirm} filled />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function SheetOption({ label, color, bold, onPress, divider }: { label: string; color: string; bold?: boolean; onPress: () => void; divider?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 57, padding: 17, alignItems: 'center', justifyContent: 'center',
        borderBottomWidth: divider ? 1 : 0, borderBottomColor: t.borderSoft,
        backgroundColor: pressed ? 'rgba(235,221,197,0.7)' : 'transparent',
      })}>
      <Text style={{ fontFamily: bold ? t.fontBodySemi : t.fontBody, fontSize: 17, color }}>{label}</Text>
    </Pressable>
  );
}

function DialogAction({ label, onPress, filled }: { label: string; onPress: () => void; filled?: boolean }) {
  // Drawn at the M3 40dp; the hit area is lifted to the 48 floor with hitSlop (§11.5).
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      hitSlop={(metrics.hitFloor - 40) / 2}
      android_ripple={{ color: filled ? t.accent : t.surfaceSunk }}
      style={{ minHeight: 40, paddingVertical: 10, paddingHorizontal: filled ? 18 : 14, borderRadius: 999, overflow: 'hidden',
        backgroundColor: filled ? t.accentDeep : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: t.fontBodySemi, fontSize: 14, color: filled ? t.accentTint : t.textMuted }}>{label}</Text>
    </Pressable>
  );
}
