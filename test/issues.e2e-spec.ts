import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { IssueCategory, IssueStatus, Role } from './../src/contracts/index.js';

const PASSWORD = 'super-secret';

const ISSUE = {
  title: 'Blocked drain',
  description: 'Standing water after every rain.',
  category: IssueCategory.DRAINAGE,
  location: 'Market Street, by the junction',
};

describe('IssuesController (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let citizenToken: string;
  let otherCitizenToken: string;
  let agencyToken: string;

  const register = (email: string) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Test User', email, password: PASSWORD });

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  const createIssue = (token: string) =>
    request(app.getHttpServer())
      .post('/issues')
      .set('Authorization', `Bearer ${token}`)
      .send(ISSUE);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());

    // The name carries a per-run and per-worker suffix, so match on the
    // marker rather than the end of the string.
    if (!connection.name.includes('_test')) {
      throw new Error(
        `Refusing to run destructive e2e tests against database "${connection.name}" ` +
          `— expected a database whose name contains "_test".`,
      );
    }

    // The actors are built once, not per test. Each register/login pair costs
    // two bcrypt operations at cost factor 12 — roughly 2.5s on a laptop — so
    // rebuilding three of them per test added ~7s to every single case. No test
    // mutates these users, only issues, so one construction is enough.
    await connection.collection('users').deleteMany({});

    await register('citizen@example.com').expect(201);
    await register('other@example.com').expect(201);
    await register('agency@example.com').expect(201);

    // Registration always creates a CITIZEN; promote one directly, since
    // granting AGENCY through the API would itself need an admin.
    await connection
      .collection('users')
      .updateOne(
        { email: 'agency@example.com' },
        { $set: { roles: [Role.AGENCY] } },
      );

    citizenToken = await login('citizen@example.com');
    otherCitizenToken = await login('other@example.com');
    agencyToken = await login('agency@example.com');
  });

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  describe('reading', () => {
    it('lists issues without a token', async () => {
      await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer()).get('/issues').expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe(ISSUE.title);
    });

    it('reads one issue without a token', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/${body.id}`)
        .expect(200);

      expect(res.body.id).toBe(body.id);
    });

    it('returns 404 for an unknown issue', async () => {
      await request(app.getHttpServer())
        .get('/issues/000000000000000000000000')
        .expect(404);
    });

    it('returns 400 for a malformed id', async () => {
      await request(app.getHttpServer()).get('/issues/nonsense').expect(400);
    });

    it('filters by status', async () => {
      await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .get(`/issues?status=${IssueStatus.OPEN}`)
        .expect(200)
        .expect((res) => expect(res.body).toHaveLength(1));

      await request(app.getHttpServer())
        .get(`/issues?status=${IssueStatus.VERIFIED}`)
        .expect(200)
        .expect((res) => expect(res.body).toHaveLength(0));
    });

    it('rejects an unknown status filter', async () => {
      await request(app.getHttpServer())
        .get('/issues?status=NONSENSE')
        .expect(400);
    });

    it('applies limit', async () => {
      await createIssue(citizenToken).expect(201);
      await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get('/issues?limit=1')
        .expect(200);

      expect(res.body).toHaveLength(1);
    });
  });

  describe('creating', () => {
    it('attributes the issue to the caller and opens it', async () => {
      const res = await createIssue(citizenToken).expect(201);

      expect(res.body.status).toBe(IssueStatus.OPEN);
      expect(res.body.reportedBy).toEqual(expect.any(String));
      expect(res.body.id).toEqual(expect.any(String));
    });

    it('refuses an anonymous create', async () => {
      await request(app.getHttpServer())
        .post('/issues')
        .send(ISSUE)
        .expect(401);
    });

    it('refuses a create from a non-citizen role', async () => {
      await request(app.getHttpServer())
        .post('/issues')
        .set('Authorization', `Bearer ${agencyToken}`)
        .send(ISSUE)
        .expect(403);
    });

    it.each(['status', 'reportedBy'])(
      'refuses a body carrying %s',
      async (field) => {
        await request(app.getHttpServer())
          .post('/issues')
          .set('Authorization', `Bearer ${citizenToken}`)
          .send({ ...ISSUE, [field]: 'VERIFIED' })
          .expect(400);
      },
    );

    it('refuses an unknown category', async () => {
      await request(app.getHttpServer())
        .post('/issues')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ ...ISSUE, category: 'NONSENSE' })
        .expect(400);
    });
  });

  describe('editing', () => {
    it('lets the reporter correct their own open issue', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/issues/${body.id}`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ title: 'Blocked drain by the junction' })
        .expect(200);

      expect(res.body.title).toBe('Blocked drain by the junction');
    });

    it('refuses a different citizen', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}`)
        .set('Authorization', `Bearer ${otherCitizenToken}`)
        .send({ title: 'Hijacked' })
        .expect(403);
    });

    it('refuses editing an issue that has left OPEN', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.REJECTED, reason: 'Out of scope' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ title: 'Too late' })
        .expect(409);
    });
  });

  describe('triage', () => {
    it('lets an agency reject an issue with a reason', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.REJECTED, reason: 'Private land' })
        .expect(200);

      expect(res.body.status).toBe(IssueStatus.REJECTED);
      expect(res.body.statusReason).toBe('Private land');
    });

    it('refuses a status change from a citizen', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ status: IssueStatus.REJECTED, reason: 'Mine now' })
        .expect(403);
    });

    it('refuses a transition that belongs to a later slice', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.VERIFIED })
        .expect(409);
    });

    it('requires a reason when rejecting', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.REJECTED })
        .expect(400);
    });

    it('marks an issue a duplicate of another', async () => {
      const { body: original } = await createIssue(citizenToken).expect(201);
      const { body: copy } = await createIssue(otherCitizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .patch(`/issues/${copy.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.DUPLICATE, duplicateOf: original.id })
        .expect(200);

      expect(res.body.status).toBe(IssueStatus.DUPLICATE);
      expect(res.body.duplicateOf).toBe(original.id);
    });

    it('refuses an issue that duplicates itself', async () => {
      const { body } = await createIssue(citizenToken).expect(201);

      await request(app.getHttpServer())
        .patch(`/issues/${body.id}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.DUPLICATE, duplicateOf: body.id })
        .expect(400);
    });
  });
});
