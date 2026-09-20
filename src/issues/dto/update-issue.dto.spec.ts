import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IssueCategory } from '../../contracts/index.js';
import { UpdateIssueDto } from './update-issue.dto.js';

// Mirrors the global pipe in app.module.ts (whitelist + forbidNonWhitelisted),
// which is what actually turns a stray property into a 400 in production.
const validateAsRequest = (dto: UpdateIssueDto) =>
  validate(dto, { whitelist: true, forbidNonWhitelisted: true });

describe('UpdateIssueDto', () => {
  it('accepts the four editable fields, all optional', async () => {
    const dto = plainToInstance(UpdateIssueDto, {
      title: 'Blocked drain on Market Street',
    });
    expect(await validateAsRequest(dto)).toHaveLength(0);
  });

  it('accepts an empty body', async () => {
    const dto = plainToInstance(UpdateIssueDto, {});
    expect(await validateAsRequest(dto)).toHaveLength(0);
  });

  // A reporter could otherwise tick an observation and clear it again before
  // submitting, evading the escalate-only rule observations are meant to
  // enforce. Removing the field from the DTO shape means the global
  // forbidNonWhitelisted pipe rejects it outright, rather than silently
  // accepting and applying it.
  it('rejects an observations key outright, rather than applying it', async () => {
    const dto = plainToInstance(UpdateIssueDto, {
      observations: ['obs-wires'],
    });
    const errors = await validateAsRequest(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'observations')).toBe(true);
  });

  it('still rejects an invalid category the same way CreateIssueDto does', async () => {
    const dto = plainToInstance(UpdateIssueDto, {
      category: 'NOT_A_CATEGORY',
    });
    expect(await validateAsRequest(dto)).not.toHaveLength(0);
  });

  it('accepts a valid category', async () => {
    const dto = plainToInstance(UpdateIssueDto, {
      category: IssueCategory.DRAINAGE,
    });
    expect(await validateAsRequest(dto)).toHaveLength(0);
  });
});
