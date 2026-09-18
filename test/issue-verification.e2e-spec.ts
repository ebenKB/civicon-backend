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

// Runs with the feature off, which is the default everywhere: no API key in a
// test environment. That is the point — the whole suite must be unchanged and
// spend nothing.
describe('AI proof verification (e2e, feature off)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let reporterToken: string;
  let volunteerToken: string;
  let agencyToken: string;
  let issueId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());
    if (!connection.name.includes('_test')) {
      throw new Error(`Refusing to run against "${connection.name}".`);
    }

    await connection.collection('users').deleteMany({});
    for (const email of ['r@x.test', 'v@x.test', 'a@x.test']) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'T', email, password: PASSWORD })
        .expect(201);
    }
    await connection
      .collection('users')
      .updateOne({ email: 'a@x.test' }, { $set: { roles: [Role.AGENCY] } });

    reporterToken = await login('r@x.test');
    volunteerToken = await login('v@x.test');
    agencyToken = await login('a@x.test');
  });

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
    await connection.collection('issue_media.files').deleteMany({});
    await connection.collection('issue_media.chunks').deleteMany({});

    const { body } = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send({
        title: 'Blocked drain',
        description: 'Standing water.',
        category: IssueCategory.DRAINAGE,
        location: 'Market Street',
      })
      .expect(201);
    issueId = body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const resolveIt = async () => {
    await request(app.getHttpServer())
      .post(`/issues/${issueId}/claim`)
      .set(auth(volunteerToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/issues/${issueId}/media`)
      .set(auth(volunteerToken))
      .attach('file', PIXEL, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
    return request(app.getHttpServer())
      .post(`/issues/${issueId}/resolution`)
      .set(auth(volunteerToken))
      .send({ note: 'Cleared it' })
      .expect(200);
  };

  const verifyIt = () =>
    request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.VERIFIED })
      .expect(200);

  it('resolves without an assessment when the feature is off', async () => {
    const res = await resolveIt();

    expect(res.body.status).toBe(IssueStatus.RESOLVED);
    expect(res.body.aiAssessment).toBeUndefined();
  });

  it('lets an agency reverse a verified issue, keeping the holder', async () => {
    const resolved = await resolveIt();
    await verifyIt();

    const reversed = await request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.IN_PROGRESS, reason: 'Still blocked' })
      .expect(200);

    expect(reversed.body.status).toBe(IssueStatus.IN_PROGRESS);
    expect(reversed.body.verifiedAt).toBeUndefined();
    expect(reversed.body.volunteer.id).toBe(resolved.body.volunteer.id);
  });

  it('refuses a reversal with no reason', async () => {
    await resolveIt();
    await verifyIt();

    await request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.IN_PROGRESS })
      .expect(400);
  });

  it('refuses a citizen reversing an approval', async () => {
    await resolveIt();
    await verifyIt();

    await request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(volunteerToken))
      .send({ status: IssueStatus.IN_PROGRESS, reason: 'mine' })
      .expect(403);
  });

  it('accepts the agency queue filter', async () => {
    await request(app.getHttpServer())
      .get('/issues?aiOutcome=BELOW_THRESHOLD')
      .expect(200);
  });

  it('rejects an unknown outcome filter', async () => {
    await request(app.getHttpServer())
      .get('/issues?aiOutcome=NONSENSE')
      .expect(400);
  });
});
