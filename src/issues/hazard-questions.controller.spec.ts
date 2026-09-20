import { Test, TestingModule } from '@nestjs/testing';
import { HAZARD_QUESTIONS } from '../contracts/index.js';
import { HazardQuestionsController } from './hazard-questions.controller.js';

describe('HazardQuestionsController', () => {
  let controller: HazardQuestionsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HazardQuestionsController],
    }).compile();

    controller = module.get<HazardQuestionsController>(
      HazardQuestionsController,
    );
  });

  // The two sets are used in completely different places — checkboxes on the
  // report form, and the text for whatever `pendingQuestions` came back with —
  // so they are served apart rather than as one list every client re-filters.
  it('serves the observations and the follow-ups separately', () => {
    const result = controller.list();

    expect(result.observations.every((q) => q.kind === 'OBSERVATION')).toBe(
      true,
    );
    expect(result.followUps.every((q) => q.kind === 'FOLLOW_UP')).toBe(true);
    expect(result.observations.length + result.followUps.length).toBe(
      HAZARD_QUESTIONS.length,
    );
  });

  // This endpoint exists so nobody hardcodes the wording: the text is still
  // awaiting field-safety review and will change. Serving ids without text
  // would leave a client no better off than before.
  it('gives every question an id and its text', () => {
    const { observations, followUps } = controller.list();

    for (const question of [...observations, ...followUps]) {
      expect(question.id).toMatch(/^[a-z0-9-]+$/);
      expect(question.text.length).toBeGreaterThan(10);
    }
  });

  it('serves the bank as it stands, not a copy that can drift', () => {
    const { observations, followUps } = controller.list();
    const served = [...observations, ...followUps].map((q) => q.id).sort();

    expect(served).toEqual(HAZARD_QUESTIONS.map((q) => q.id).sort());
  });

  it('includes a known observation and a known follow-up', () => {
    const { observations, followUps } = controller.list();

    expect(observations.map((q) => q.id)).toContain('obs-wires');
    expect(followUps.map((q) => q.id)).toContain('elec-1');
  });
});
