import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { HAZARD_QUESTIONS } from '../contracts/index.js';
import type { HazardQuestion } from '../contracts/index.js';

/**
 * The question shape clients render. Explicit, like every other response in
 * this codebase: `tags` stay server-side, because they exist to steer the
 * model's selection and are not something a reporter should be shown.
 */
export interface PublicHazardQuestion {
  id: string;
  text: string;
  kind: HazardQuestion['kind'];
}

export interface PublicHazardQuestions {
  /** Offered as checkboxes when reporting. Ticking one restricts outright. */
  observations: PublicHazardQuestion[];
  /** The pool `pendingQuestions` draws from. */
  followUps: PublicHazardQuestion[];
}

const toPublic = (question: HazardQuestion): PublicHazardQuestion => ({
  id: question.id,
  text: question.text,
  kind: question.kind,
});

/**
 * Serves the hazard question bank so no client has to hardcode it.
 *
 * Worth the route: the ids are a stable contract, but the wording is not
 * settled — it is still awaiting review by someone with field-safety
 * knowledge, and it is read by people standing next to a hazard. A copy
 * inside a client would go stale silently, and two systems would be asking
 * different safety questions.
 *
 * Public, because the report form needs it before anyone has signed in.
 */
@Controller('hazard')
export class HazardQuestionsController {
  @Public()
  @Get('questions')
  // Fixed at build time: it can only change when the server is redeployed.
  @Header('Cache-Control', 'public, max-age=3600')
  list(): PublicHazardQuestions {
    return {
      observations: HAZARD_QUESTIONS.filter(
        (question) => question.kind === 'OBSERVATION',
      ).map(toPublic),
      followUps: HAZARD_QUESTIONS.filter(
        (question) => question.kind === 'FOLLOW_UP',
      ).map(toPublic),
    };
  }
}
