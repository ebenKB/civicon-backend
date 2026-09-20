export interface HazardQuestion {
  /** Stable forever: answers are stored against it. Never reuse a retired id. */
  id: string;
  text: string;
  tags: string[];
  /**
   * OBSERVATION entries are offered as checkboxes when reporting, and ticking
   * one restricts the issue outright. FOLLOW_UP entries are what the model may
   * select when it cannot decide.
   */
  kind: 'OBSERVATION' | 'FOLLOW_UP';
}

export const HAZARD_QUESTIONS: readonly HazardQuestion[] = [
  // --- Observations: ticked by the reporter, escalate on their own ---
  {
    id: 'obs-wires',
    kind: 'OBSERVATION',
    tags: ['electrical'],
    text: 'I can see loose, broken or hanging electrical wires',
  },
  {
    id: 'obs-water-electric',
    kind: 'OBSERVATION',
    tags: ['electrical', 'water'],
    text: 'Water is touching something electrical',
  },
  {
    id: 'obs-collapse',
    kind: 'OBSERVATION',
    tags: ['structural'],
    text: 'Part of a structure has collapsed, or is leaning',
  },
  {
    id: 'obs-gas',
    kind: 'OBSERVATION',
    tags: ['gas'],
    text: 'There is a smell of gas or fuel',
  },
  {
    id: 'obs-deep-water',
    kind: 'OBSERVATION',
    tags: ['water'],
    text: 'The water is deep or moving fast',
  },
  {
    id: 'obs-traffic',
    kind: 'OBSERVATION',
    tags: ['traffic'],
    text: 'It is in a lane where vehicles are still driving',
  },

  // --- Follow-ups: selected by the model when it cannot decide ---
  {
    id: 'elec-1',
    kind: 'FOLLOW_UP',
    tags: ['electrical'],
    text: 'Are any wires hanging down, broken, or lying on the ground?',
  },
  {
    id: 'elec-2',
    kind: 'FOLLOW_UP',
    tags: ['electrical', 'water'],
    text: 'Is anything electrical in contact with water?',
  },
  {
    id: 'elec-3',
    kind: 'FOLLOW_UP',
    tags: ['electrical'],
    text: 'Is the pole or its cover damaged, leaning, or open?',
  },
  {
    id: 'elec-4',
    kind: 'FOLLOW_UP',
    tags: ['electrical'],
    text: 'Can you hear buzzing, see sparks, or smell burning?',
  },
  {
    id: 'water-1',
    kind: 'FOLLOW_UP',
    tags: ['water'],
    text: 'Is the water deeper than knee height?',
  },
  {
    id: 'water-2',
    kind: 'FOLLOW_UP',
    tags: ['water'],
    text: 'Is the water moving fast enough to push against your legs?',
  },
  {
    id: 'water-3',
    kind: 'FOLLOW_UP',
    tags: ['water', 'structural'],
    text: 'Is a drain or manhole cover missing or open?',
  },
  {
    id: 'traffic-1',
    kind: 'FOLLOW_UP',
    tags: ['traffic'],
    text: 'Are vehicles still driving past the spot?',
  },
  {
    id: 'traffic-2',
    kind: 'FOLLOW_UP',
    tags: ['traffic'],
    text: 'Would someone working on this have to stand in the road?',
  },
  {
    id: 'traffic-3',
    kind: 'FOLLOW_UP',
    tags: ['traffic'],
    text: 'Is this on a main road rather than a side street?',
  },
  {
    id: 'struct-1',
    kind: 'FOLLOW_UP',
    tags: ['structural'],
    text: 'Has any part of a wall, roof, pole or bridge already fallen?',
  },
  {
    id: 'struct-2',
    kind: 'FOLLOW_UP',
    tags: ['structural'],
    text: 'Is anything leaning, cracked, or looking likely to fall?',
  },
  {
    id: 'struct-3',
    kind: 'FOLLOW_UP',
    tags: ['structural', 'height'],
    text: 'Is there loose material overhead?',
  },
  {
    id: 'gas-1',
    kind: 'FOLLOW_UP',
    tags: ['gas'],
    text: 'Can you smell gas, petrol or diesel?',
  },
  {
    id: 'gas-2',
    kind: 'FOLLOW_UP',
    tags: ['gas', 'fire'],
    text: 'Is there any fire, smoke, or heat coming from it?',
  },
  {
    id: 'height-1',
    kind: 'FOLLOW_UP',
    tags: ['height'],
    text: 'Would someone need a ladder, or to climb, to reach it?',
  },
  {
    id: 'height-2',
    kind: 'FOLLOW_UP',
    tags: ['height'],
    text: 'Is it above head height?',
  },
  {
    id: 'gen-1',
    kind: 'FOLLOW_UP',
    tags: ['general'],
    text: 'Is there broken glass, sharp metal, or medical waste?',
  },
  {
    id: 'gen-2',
    kind: 'FOLLOW_UP',
    tags: ['general', 'chemical'],
    text: 'Is anything chemical leaking or spilled?',
  },
  {
    id: 'gen-3',
    kind: 'FOLLOW_UP',
    tags: ['general'],
    text: 'Is the area already fenced off, taped off, or being guarded?',
  },
] as const;

const BY_ID = new Map(HAZARD_QUESTIONS.map((q) => [q.id, q]));

export function findQuestion(id: string): HazardQuestion | undefined {
  return BY_ID.get(id);
}

/** Offered as checkboxes when reporting. */
export function observationIds(): string[] {
  return HAZARD_QUESTIONS.filter((q) => q.kind === 'OBSERVATION').map(
    (q) => q.id,
  );
}

/** The pool the model may select from. */
export function followUpIds(): string[] {
  return HAZARD_QUESTIONS.filter((q) => q.kind === 'FOLLOW_UP').map(
    (q) => q.id,
  );
}
