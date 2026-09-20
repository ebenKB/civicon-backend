import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { HazardLevel } from '../../contracts/index.js';
import { SetHazardDto } from './set-hazard.dto.js';

describe('SetHazardDto', () => {
  it('accepts RESTRICTED with a reason', async () => {
    const dto = plainToInstance(SetHazardDto, {
      level: HazardLevel.RESTRICTED,
      reason: 'Live cable, utility only',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts UNRESTRICTED with a reason', async () => {
    const dto = plainToInstance(SetHazardDto, {
      level: HazardLevel.UNRESTRICTED,
      reason: 'Ordinary streetlight',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  // NEEDS_REVIEW is a state the system arrives at, never a choice a person
  // makes: a human decision is a decision.
  it('rejects NEEDS_REVIEW', async () => {
    const dto = plainToInstance(SetHazardDto, {
      level: HazardLevel.NEEDS_REVIEW,
      reason: 'Not sure',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects UNCLASSIFIED', async () => {
    const dto = plainToInstance(SetHazardDto, {
      level: HazardLevel.UNCLASSIFIED,
      reason: 'Not sure',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects a missing reason', async () => {
    const dto = plainToInstance(SetHazardDto, {
      level: HazardLevel.RESTRICTED,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects an empty reason', async () => {
    const dto = plainToInstance(SetHazardDto, {
      level: HazardLevel.RESTRICTED,
      reason: '',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects a reason over 500 characters', async () => {
    const dto = plainToInstance(SetHazardDto, {
      level: HazardLevel.RESTRICTED,
      reason: 'x'.repeat(501),
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
