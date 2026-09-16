import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { IssueCategory, IssueStatus } from '../contracts/index.js';
import { IssueLifecycleService } from './issue-lifecycle.service.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';

const reporterId = new Types.ObjectId();

const issueDoc = () =>
  ({
    _id: new Types.ObjectId(),
    title: 'Blocked drain',
    description: 'Water standing after rain.',
    category: IssueCategory.DRAINAGE,
    location: 'Market Street',
    status: IssueStatus.OPEN,
    reportedBy: reporterId,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as never;

const caller = {
  id: reporterId.toString(),
  email: 'citizen@civicon.test',
  roles: [],
} as never;

describe('IssuesController', () => {
  let controller: IssuesController;
  let service: Record<string, ReturnType<typeof vi.fn>>;
  let lifecycle: Record<string, ReturnType<typeof vi.fn>>;
  let mediaService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAll: vi.fn(),
      findOne: vi.fn(),
      updateOwn: vi.fn(),
    };
    lifecycle = {
      changeStatus: vi.fn(),
      claim: vi.fn(),
      release: vi.fn(),
      start: vi.fn(),
      resolve: vi.fn(),
    };
    mediaService = { listFor: vi.fn(), listForMany: vi.fn() };
    mediaService.listFor.mockResolvedValue([]);
    mediaService.listForMany.mockResolvedValue(new Map());

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IssuesController],
      providers: [
        { provide: IssuesService, useValue: service },
        { provide: IssueLifecycleService, useValue: lifecycle },
        { provide: IssueMediaService, useValue: mediaService },
      ],
    }).compile();

    controller = module.get<IssuesController>(IssuesController);
  });

  it('passes the caller id to create, not anything from the body', async () => {
    service.create.mockResolvedValue(issueDoc());
    const dto = {
      title: 'Blocked drain',
      description: 'Water standing after rain.',
      category: IssueCategory.DRAINAGE,
      location: 'Market Street',
    };

    await controller.create(caller, dto);

    expect(service.create).toHaveBeenCalledWith(reporterId.toString(), dto);
  });

  it('returns the public shape from create', async () => {
    service.create.mockResolvedValue(issueDoc());

    const result = await controller.create(caller, {
      title: 'Blocked drain',
      description: 'Water standing after rain.',
      category: IssueCategory.DRAINAGE,
      location: 'Market Street',
    });

    expect(result.status).toBe(IssueStatus.OPEN);
    expect(typeof result.reportedBy).toBe('string');
  });

  it('maps every issue in a listing to the public shape', async () => {
    service.findAll.mockResolvedValue([issueDoc(), issueDoc()]);

    const result = await controller.findAll({});

    expect(result).toHaveLength(2);
    expect(typeof result[0].id).toBe('string');
  });

  it('delegates findOne to the service', async () => {
    service.findOne.mockResolvedValue(issueDoc());

    await controller.findOne('507f1f77bcf86cd799439011');

    expect(service.findOne).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
  });
  it('passes the caller id to updateOwn so ownership can be checked', async () => {
    service.updateOwn.mockResolvedValue(issueDoc());

    await controller.update('507f1f77bcf86cd799439011', caller, {
      title: 'Corrected',
    });

    expect(service.updateOwn).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      reporterId.toString(),
      { title: 'Corrected' },
    );
  });
  it('routes a status change through the lifecycle service', async () => {
    lifecycle.changeStatus.mockResolvedValue(issueDoc());

    await controller.changeStatus('507f1f77bcf86cd799439011', {
      status: IssueStatus.REJECTED,
      reason: 'Out of scope',
    });

    expect(lifecycle.changeStatus).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      { status: IssueStatus.REJECTED, reason: 'Out of scope' },
    );
  });
  it('fetches media for a whole page in one query, not one per issue', async () => {
    service.findAll.mockResolvedValue([issueDoc(), issueDoc()]);

    await controller.findAll({});

    expect(mediaService.listForMany).toHaveBeenCalledTimes(1);
    expect(mediaService.listFor).not.toHaveBeenCalled();
  });
  it.each([
    ['claim', 'claim'],
    ['release', 'release'],
    ['start', 'start'],
  ])('passes the caller id to %s', async (method, lifecycleMethod) => {
    lifecycle[lifecycleMethod].mockResolvedValue(issueDoc());

    await (
      controller as unknown as Record<
        string,
        (id: string, user: unknown) => Promise<unknown>
      >
    )[method]('507f1f77bcf86cd799439011', caller);

    expect(lifecycle[lifecycleMethod]).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      reporterId.toString(),
    );
  });

  it('passes the note and the caller id to resolve', async () => {
    lifecycle.resolve.mockResolvedValue(issueDoc());

    await controller.resolve('507f1f77bcf86cd799439011', caller, {
      note: 'Cleared it',
    });

    expect(lifecycle.resolve).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      reporterId.toString(),
      { note: 'Cleared it' },
    );
  });
});
