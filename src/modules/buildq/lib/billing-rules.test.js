// Run with:  node --test src/modules/buildq/lib/billing-rules.test.js
//
// These cover the three reported failures the rules exist to prevent, and they
// are pure functions with no database or network, so they run anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BILL_SKELETON,
  coverageGaps,
  coverageNotes,
  isReinforcementItem,
  rebarSizeOf,
  reinforcementWarnings,
  roofFromFootprint,
  skeletonForPrompt,
} from './billing-rules.js';

test('bar sizes are read out of a description', () => {
  assert.equal(rebarSizeOf('High-yield reinforcement, Y16 bars, to bases'), 'Y16');
  assert.equal(rebarSizeOf('Mild steel links/stirrups, R8 bars'), 'R8');
  assert.equal(rebarSizeOf('BRC mesh A142 to ground floor slab'), 'A142');
  assert.equal(rebarSizeOf('Reinforcement to substructure'), null);
});

test('reinforcement is told apart from reinforced concrete', () => {
  // The stem has to match the whole word: "reinforc" is followed by "ement"
  // and "ed", so a closing word boundary would never fire.
  assert.equal(isReinforcementItem('Reinforcement to substructure'), true);
  assert.equal(isReinforcementItem('Y16 high-yield reinforcement'), true);
  // A concrete item is measured in m³ and must not be asked for a bar size.
  assert.equal(isReinforcementItem('Reinforced concrete (1:2:4) in bases'), false);
  assert.equal(isReinforcementItem('225mm sandcrete block wall'), false);
});

test('an aggregate steel line is refused', () => {
  const notes = reinforcementWarnings([
    { description: 'Reinforcement to substructure', section: 'Substructure', unit: 'tonne', qty: 18.4 },
    { description: 'Reinforced concrete (1:2:4) in bases', section: 'Substructure', unit: 'm³', qty: 160 },
  ]);
  assert.ok(notes.some((n) => /names no bar size/.test(n.text)));
  // 18.4 t over 160 m³ is 115 kg/m³ — inside the band, so nothing else fires.
  assert.equal(notes.length, 1);
});

test('steel that does not reconcile to the concrete is flagged', () => {
  const thin = reinforcementWarnings([
    { description: 'Y16 high-yield reinforcement', section: 'Substructure', unit: 'tonne', qty: 4 },
    { description: 'Reinforced concrete (1:2:4) in bases', section: 'Substructure', unit: 'm³', qty: 160 },
  ]);
  assert.ok(thin.some((n) => /kg per m³/.test(n.text)));

  const none = reinforcementWarnings([
    { description: 'Reinforced concrete (1:2:4) in bases', section: 'Substructure', unit: 'm³', qty: 160 },
  ]);
  assert.ok(none.some((n) => /no reinforcement/.test(n.text)));
});

// The gap that was actually reported from use.
test('missing wall screeding is reported, not silently dropped', () => {
  const bill = [
    { description: 'Reinforced concrete (1:2:4) in bases', section: 'Substructure', unit: 'm³', qty: 160 },
    { description: '225mm sandcrete block wall', section: 'Superstructure', unit: 'm²', qty: 412 },
    { description: 'Emulsion paint, 3 coats', section: 'Finishes', unit: 'm²', qty: 800 },
  ];
  const keys = coverageGaps(bill).map((g) => g.key);

  assert.ok(keys.includes('render-internal'));
  assert.ok(keys.includes('render-external'));
  assert.ok(keys.includes('roof-carcass'));
  // Painting IS billed, so it must not be reported missing.
  assert.ok(!keys.includes('painting'));

  const notes = coverageNotes(bill);
  assert.ok(notes.every((n) => n.type === 'warning'));
  assert.match(notes.find((n) => n.section === 'Finishes').text, /screeding/i);
  // One note per section, so a thin bill does not bury the reader.
  assert.equal(new Set(notes.map((n) => n.section)).size, notes.length);
});

test('billing an item clears its gap', () => {
  const bill = [
    { description: 'Cement/sand render to internal walls', section: 'Finishes', unit: 'm²', qty: 900 },
  ];
  assert.ok(!coverageGaps(bill).map((g) => g.key).includes('render-internal'));
});

test('a roof is derivable from the footprint alone', () => {
  const roof = roofFromFootprint(200);
  assert.equal(roof.pitchDegrees, 30);
  assert.ok(roof.trueAreaM2 > roof.planAreaM2);
  // A 30° roof is 15.47% larger than its plan projection.
  assert.ok(Math.abs(roof.trueAreaM2 / roof.planAreaM2 - 1.1547) < 0.001);
  assert.ok(Math.abs(roof.carcassM3 / roof.trueAreaM2 - 0.045) < 0.001);
  assert.equal(roof.ceilingM2, 200);
  // Nothing to measure means nothing returned, rather than a zero-value item.
  assert.equal(roofFromFootprint(0), null);
});

test('the prompt fragment carries every skeleton entry', () => {
  const prompt = skeletonForPrompt();
  for (const entry of BILL_SKELETON) assert.ok(prompt.includes(entry.label), entry.key);
  assert.match(prompt, /screeding/i);
});
