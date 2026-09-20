import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IssueCategory } from '../../contracts/index.js';
import { CreateIssueDto } from './create-issue.dto.js';

const base = {
  title: 'Blocked drain',
  description: 'Standing water after rain.',
  category: IssueCategory.DRAINAGE,
  location: 'Market Street',
};

describe('CreateIssueDto observations', () => {
  it('accepts ids from the bank', async () => {
    const dto = plainToInstance(CreateIssueDto, {
      ...base,
      observations: ['obs-wires'],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  // A made-up id would be stored and then never resolve to a question, so the
  // record of what someone was asked would be a lie.
  it('refuses an id that is not a question', async () => {
    const dto = plainToInstance(CreateIssueDto, {
      ...base,
      observations: ['obs-made-up'],
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('refuses a follow-up id: those are not offered at report time', async () => {
    const dto = plainToInstance(CreateIssueDto, {
      ...base,
      observations: ['elec-1'],
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('is optional', async () => {
    const dto = plainToInstance(CreateIssueDto, base);
    expect(await validate(dto)).toHaveLength(0);
  });
});
