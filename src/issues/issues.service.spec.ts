import { NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { IssueCategory, IssueStatus } from '../contracts/index.js';
import { IssuesService } from './issues.service.js';
import { Issue } from './schemas/issue.schema.js';

const execOf = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

/** Mongoose query builders are chainable, so the list mock returns itself. */
const chainOf = <T>(value: T) => {
  const chain = {
    sort: vi.fn(() => chain),
    skip: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    exec: () => Promise.resolve(value),
  };
  return chain;
};

const REPORTER = '507f1f77bcf86cd799439011';

describe('IssuesService', () => {
  let service: IssuesService;
  let model: {
    create: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    model = { create: vi.fn(), find: vi.fn(), findById: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuesService,
        { provide: getModelToken(Issue.name), useValue: model },
      ],
    }).compile();

    service = module.get<IssuesService>(IssuesService);
  });

  describe('create', () => {
    const dto = {
      title: 'Blocked drain',
      description: 'Water standing after rain.',
      category: IssueCategory.DRAINAGE,
      location: 'Market Street',
    };

    it('attributes the issue to the caller, not to anything in the body', async () => {
      model.create.mockResolvedValue({});

      await service.create(REPORTER, dto);

      const [input] = model.create.mock.calls[0];
      expect(input.reportedBy.toString()).toBe(REPORTER);
    });

    it('passes no status, leaving the schema default to supply OPEN', async () => {
      model.create.mockResolvedValue({});

      await service.create(REPORTER, dto);

      const [input] = model.create.mock.calls[0];
      expect(input).not.toHaveProperty('status');
    });
  });

  describe('findAll', () => {
    it('applies no filter when the query is empty', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({});

      expect(model.find).toHaveBeenCalledWith({});
    });

    it('filters by status and category', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({
        status: IssueStatus.OPEN,
        category: IssueCategory.ROADS,
      });

      expect(model.find).toHaveBeenCalledWith({
        status: IssueStatus.OPEN,
        category: IssueCategory.ROADS,
      });
    });

    it('filters by reporter as an ObjectId, not a string', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({ reportedBy: REPORTER });

      const [filter] = model.find.mock.calls[0];
      expect(filter.reportedBy).toBeInstanceOf(Types.ObjectId);
      expect(filter.reportedBy.toString()).toBe(REPORTER);
    });

    it('sorts newest first and applies the default paging window', async () => {
      const chain = chainOf([]);
      model.find.mockReturnValue(chain);

      await service.findAll({});

      expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(chain.skip).toHaveBeenCalledWith(0);
      expect(chain.limit).toHaveBeenCalledWith(20);
    });

    it('honours an explicit limit and offset', async () => {
      const chain = chainOf([]);
      model.find.mockReturnValue(chain);

      await service.findAll({ limit: 5, offset: 10 });

      expect(chain.skip).toHaveBeenCalledWith(10);
      expect(chain.limit).toHaveBeenCalledWith(5);
    });
  });

  describe('findOne', () => {
    it('returns the issue when it exists', async () => {
      model.findById.mockReturnValue(execOf({ title: 'Blocked drain' }));

      await expect(service.findOne('anything')).resolves.toMatchObject({
        title: 'Blocked drain',
      });
    });

    it('throws NotFoundException when it does not', async () => {
      model.findById.mockReturnValue(execOf(null));

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
