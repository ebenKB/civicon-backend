import { Readable, Writable } from 'node:stream';
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
  describe('download', () => {
    /**
     * A real Writable, because the route pipes the media stream into it — a
     * plain object double fails with "dest.on is not a function" and would
     * have hidden whether piping works at all.
     */
    const responseDouble = () => {
      const res = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }) as Writable & {
        status: ReturnType<typeof vi.fn>;
        set: ReturnType<typeof vi.fn>;
      };
      res.status = vi.fn(() => res);
      res.set = vi.fn(() => res);
      return res;
    };

    const streamFor = (
      body: string,
      range?: { start: number; end: number },
    ) => ({
      stream: Readable.from([Buffer.from(body)]),
      contentType: 'image/png',
      size: 1000,
      range,
    });

    it('answers 200 with the whole file when no range is asked for', async () => {
      service.openDownload.mockResolvedValue(streamFor('whole'));
      const res = responseDouble();

      await controller.download('507f1f77bcf86cd799439033', {}, res as never);

      expect(service.openDownload).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439033',
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const [headers] = res.set.mock.calls[0];
      expect(headers['Accept-Ranges']).toBe('bytes');
      expect(headers['Content-Length']).toBe('1000');
      expect(headers['Content-Range']).toBeUndefined();
    });

    it('answers 206 with Content-Range for a partial request', async () => {
      service.openDownload
        .mockResolvedValueOnce(streamFor('whole'))
        .mockResolvedValueOnce(streamFor('part', { start: 0, end: 99 }));
      const res = responseDouble();

      await controller.download(
        '507f1f77bcf86cd799439033',
        { range: 'bytes=0-99' },
        res as never,
      );

      expect(service.openDownload).toHaveBeenLastCalledWith(
        '507f1f77bcf86cd799439033',
        { start: 0, end: 99 },
      );
      expect(res.status).toHaveBeenCalledWith(206);
      const [headers] = res.set.mock.calls[0];
      expect(headers['Content-Range']).toBe('bytes 0-99/1000');
      expect(headers['Content-Length']).toBe('100');
    });

    it('answers 416 for an unsatisfiable range', async () => {
      service.openDownload.mockResolvedValue(streamFor('whole'));
      const res = responseDouble();

      await expect(
        controller.download(
          '507f1f77bcf86cd799439033',
          { range: 'bytes=5000-6000' },
          res as never,
        ),
      ).rejects.toThrow(/range/i);
    });
  });
});
