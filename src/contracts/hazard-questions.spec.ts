import {
  HAZARD_QUESTIONS,
  findQuestion,
  observationIds,
  followUpIds,
} from './hazard-questions.js';

describe('the hazard question bank', () => {
  // Answers are stored against ids forever, so a duplicate would corrupt the
  // record of what someone was actually asked.
  it('has unique ids', () => {
    const ids = HAZARD_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every question text and at least one tag', () => {
    for (const question of HAZARD_QUESTIONS) {
      expect(question.text.length).toBeGreaterThan(10);
      expect(question.tags.length).toBeGreaterThan(0);
    }
  });

  it('splits into observations shown at report time and follow-ups', () => {
    expect(observationIds().length).toBeGreaterThan(0);
    expect(followUpIds().length).toBeGreaterThan(0);
    expect([...observationIds(), ...followUpIds()].sort()).toEqual(
      HAZARD_QUESTIONS.map((q) => q.id).sort(),
    );
  });

  it('finds a question by id and nothing by a made-up one', () => {
    expect(findQuestion('obs-wires')?.kind).toBe('OBSERVATION');
    expect(findQuestion('not-a-question')).toBeUndefined();
  });
});
