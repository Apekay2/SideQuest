// The consent the API records has to be one the person actually gave: unticked by default,
// and nothing is sent until they tick it.

import { render, screen, fireEvent } from '@testing-library/react-native';
import { LEGAL_VERSIONS } from '@sidequest/contracts';
import { LegalConsent } from './components/LegalConsent';
import { acceptance } from './lib/legal';
import { useState } from 'react';

function Harness({ onChange }: { onChange: (v: boolean) => void }) {
  const [c, setC] = useState(false);
  return <LegalConsent checked={c} onChange={(v) => { setC(v); onChange(v); }} />;
}

describe('legal consent', () => {
  test('starts unticked, is a real checkbox, and toggles', async () => {
    const onChange = jest.fn();
    await render(<Harness onChange={onChange} />);
    const box = screen.getByRole('checkbox');
    expect(box.props.accessibilityState).toEqual({ checked: false });
    await fireEvent.press(box);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('checkbox').props.accessibilityState).toEqual({ checked: true });
  });

  test('both documents are reachable from the text', async () => {
    await render(<LegalConsent checked={false} onChange={jest.fn()} />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  test('sends the versions this build shows, with the 18+ confirmation', () => {
    expect(acceptance()).toEqual({ terms: LEGAL_VERSIONS.terms, privacy: LEGAL_VERSIONS.privacy, adult: true });
  });
});
