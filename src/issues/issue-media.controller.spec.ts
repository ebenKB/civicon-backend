import { Test, TestingModule } from '@nestjs/testing';
import { IssueMediaController } from './issue-media.controller.js';
import { IssueMediaService } from './issue-media.service.js';

const ISSUE_ID = '507f1f77bcf86cd799439022';

const caller = {
  id: '507f1f77bcf86cd799439011',
  email: 'citizen@civicon.test',
  roles: [],
} as never;

const media = {
  id: 'abc',
  filename: 'culvert.png',
  contentType: 'image/png',
  size: 1234,
  uploadedAt: new Date(),
  url: '/issues/media/abc',
};

describe('IssueMediaController', () => {
  let controller: IssueMediaController;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    service = {
      upload: vi.fn(),
      listFor: vi.fn(),
      openDownload: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IssueMediaController],
      providers: [{ provide: IssueMediaService, useValue: service }],
    }).compile();

    controller = module.get<IssueMediaController>(IssueMediaController);
  });

  it('passes the issue, the caller and the file to the service', async () => {
    service.upload.mockResolvedValue(media);
    const file = {
      originalname: 'culvert.png',
      mimetype: 'image/png',
      size: 1234,
      buffer: Buffer.alloc(0),
    };

    await controller.upload(ISSUE_ID, caller, file as never);

    expect(service.upload).toHaveBeenCalledWith(
      ISSUE_ID,
      '507f1f77bcf86cd799439011',
      file,
    );
  });

  // The guard throws synchronously, before any promise is returned, so this
  // assertion must be synchronous too.
  it('rejects a request carrying no file', () => {
    expect(() =>
      controller.upload(ISSUE_ID, caller, undefined as never),
    ).toThrow(/file/i);
  });

  it('delegates the metadata listing', async () => {
    service.listFor.mockResolvedValue([media]);

    await expect(controller.listFor(ISSUE_ID)).resolves.toEqual([media]);
    expect(service.listFor).toHaveBeenCalledWith(ISSUE_ID);
  });
});
