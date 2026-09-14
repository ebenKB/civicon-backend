import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { IssueCategory, IssueStatus, Role } from './../src/contracts/index.js';

const PASSWORD = 'super-secret';
const PIXEL = readFileSync(join(import.meta.dirname, 'fixtures/pixel.png'));

const ISSUE = {
  title: 'Collapsed culvert',
  description: 'Gave way after Sunday rain.',
  category: IssueCategory.DRAINAGE,
  location: 'School road',
};

describe('IssueMedia (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let citizenToken: string;
  let otherCitizenToken: string;
  let agencyToken: string;
  let issueId: string;

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  const attach = (
    token: string,
    buffer = PIXEL,
    name = 'pixel.png',
    type = 'image/png',
  ) =>
    request(app.getHttpServer())
      .post(`/issues/${issueId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename: name, contentType: type });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());
    if (!connection.name.endsWith('_test')) {
      throw new Error(
        `Refusing to run destructive e2e tests against database "${connection.name}" ` +
          `— expected a database ending in "_test".`,
      );
    }

    // Actors are built once: each register/login pair is two bcrypt operations
    // at cost factor 12, about 2.5s.
    await connection.collection('users').deleteMany({});
    for (const email of ['citizen@x.test', 'other@x.test', 'agency@x.test']) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'Test User', email, password: PASSWORD })
        .expect(201);
    }
    await connection
      .collection('users')
      .updateOne(
        { email: 'agency@x.test' },
        { $set: { roles: [Role.AGENCY] } },
      );

    citizenToken = await login('citizen@x.test');
    otherCitizenToken = await login('other@x.test');
    agencyToken = await login('agency@x.test');
  });

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
    await connection.collection('issue_media.files').deleteMany({});
    await connection.collection('issue_media.chunks').deleteMany({});

    const { body } = await request(app.getHttpServer())
      .post('/issues')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send(ISSUE)
      .expect(201);
    issueId = body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('uploading', () => {
    it('stores an image and returns its metadata', async () => {
      const res = await attach(citizenToken).expect(201);

      expect(res.body).toMatchObject({
        filename: 'pixel.png',
        contentType: 'image/png',
        size: PIXEL.length,
      });
      expect(res.body.url).toBe(`/issues/media/${res.body.id}`);
    });

    it('accepts a video type', async () => {
      await attach(
        citizenToken,
        Buffer.from('fake mp4 bytes'),
        'clip.mp4',
        'video/mp4',
      ).expect(201);
    });

    it('refuses an anonymous upload', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/media`)
        .attach('file', PIXEL, {
          filename: 'pixel.png',
          contentType: 'image/png',
        })
        .expect(401);
    });

    it('refuses a citizen who did not report the issue', async () => {
      await attach(otherCitizenToken).expect(403);
    });

    it('refuses a disallowed type with 415', async () => {
      await attach(
        citizenToken,
        Buffer.from('%PDF-1.4'),
        'doc.pdf',
        'application/pdf',
      ).expect(415);
    });

    it('refuses a sixth file with 409', async () => {
      for (let i = 0; i < 5; i++) {
        await attach(citizenToken).expect(201);
      }
      await attach(citizenToken).expect(409);
    });

    it('refuses once the issue has left OPEN', async () => {
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.REJECTED, reason: 'Private land' })
        .expect(200);

      await attach(citizenToken).expect(409);
    });

    it('rejects a request carrying no file', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/media`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .expect(400);
    });
  });

  describe('serving', () => {
    it('returns the bytes unchanged, with no token', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/media/${media.id}`)
        .expect(200)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.compare(res.body as Buffer, PIXEL)).toBe(0);
    });

    it('answers a range request with 206 and the right slice', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/media/${media.id}`)
        .set('Range', 'bytes=0-9')
        .expect(206);

      expect(res.headers['content-range']).toBe(`bytes 0-9/${PIXEL.length}`);
      expect(res.headers['content-length']).toBe('10');
    });

    it('answers 416 for an unsatisfiable range', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      await request(app.getHttpServer())
        .get(`/issues/media/${media.id}`)
        .set('Range', 'bytes=99999-')
        .expect(416);
    });

    it('returns 404 for an unknown media id', async () => {
      await request(app.getHttpServer())
        .get('/issues/media/000000000000000000000000')
        .expect(404);
    });
  });

  describe('listing', () => {
    it('lists metadata publicly', async () => {
      await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/${issueId}/media`)
        .expect(200);

      expect(res.body).toHaveLength(1);
    });

    it('carries media on the issue detail', async () => {
      await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/${issueId}`)
        .expect(200);

      expect(res.body.media).toHaveLength(1);
    });

    it('carries media on the issue listing', async () => {
      await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer()).get('/issues').expect(200);

      const found = res.body.find((i: { id: string }) => i.id === issueId);
      expect(found.media).toHaveLength(1);
    });

    it('has an index on metadata.issueId, so listing is not a scan', async () => {
      await attach(citizenToken).expect(201);

      const indexes = await connection
        .collection('issue_media.files')
        .indexes();

      expect(indexes.some((i) => i.key['metadata.issueId'] === 1)).toBe(true);
    });

    it('reports an empty array for an issue with no media', async () => {
      const res = await request(app.getHttpServer())
        .get(`/issues/${issueId}`)
        .expect(200);

      expect(res.body.media).toEqual([]);
    });
  });

  describe('deleting', () => {
    it('removes the file and its chunks', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      await request(app.getHttpServer())
        .delete(`/issues/media/${media.id}`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/issues/media/${media.id}`)
        .expect(404);

      expect(
        await connection.collection('issue_media.chunks').countDocuments(),
      ).toBe(0);
    });

    it('refuses a citizen who did not report the issue', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      await request(app.getHttpServer())
        .delete(`/issues/media/${media.id}`)
        .set('Authorization', `Bearer ${otherCitizenToken}`)
        .expect(403);
    });
  });
});
