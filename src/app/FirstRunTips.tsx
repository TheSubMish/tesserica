import { useState } from 'react';

import { markTipsDone, tipsDone } from './startupPrefs';

const TIPS = [
  {
    title: 'Two halves, one app',
    body: 'Convert turns a photo into pixel art. “Edit →” sends it into the editor as a layer that stays re-renderable.',
  },
  {
    title: 'Everything is searchable',
    body: 'Press Ctrl+K to find any tool, file action or setting by typing a few letters.',
  },
  {
    title: 'Pick any colour',
    body: 'Click the colour squares at the bottom of the tool rail for the wheel. Press X to swap them.',
  },
] as const;

/** Three one-time tips, shown after the welcome screen closes and never again once dismissed. */
export function FirstRunTips() {
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(tipsDone);
  if (done) return null;

  const finish = (): void => {
    markTipsDone();
    setDone(true);
  };
  const tip = TIPS[step];
  const last = step === TIPS.length - 1;

  return (
    <aside className="first-run-tip" role="complementary" aria-label="Tip">
      <p className="tip-step">
        Tip {step + 1} of {TIPS.length}
      </p>
      <strong>{tip.title}</strong>
      <p>{tip.body}</p>
      <div className="tip-actions">
        <button type="button" className="link-btn" onClick={finish}>
          Skip tips
        </button>
        <button type="button" onClick={() => (last ? finish() : setStep(step + 1))}>
          {last ? 'Got it' : 'Next'}
        </button>
      </div>
    </aside>
  );
}
