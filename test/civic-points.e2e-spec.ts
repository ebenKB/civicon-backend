import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import {
  IssueCategory,
  IssueStatus,
  PointsReason,
  Role,
} from './../src/contracts/index.js';

const PASSWORD = 'super-secret';
const PIXEL = readFileSync(join(import.meta.dirname, 'fixtures/pixel.png'));

describe('Civic points (e2e)', () => {
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

  const points = () =>
    request(app.getHttpServer())
      .get('/users/me/points')
      .set(auth(volunteerToken));

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
    await connection.collection('point_transactions').deleteMany({});
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

    await request(app.getHttpServer())
      .post(`/issues/${issueId}/claim`)
      .set(auth(volunteerToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/issues/${issueId}/media`)
      .set(auth(volunteerToken))
      .attach('file', PIXEL, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/issues/${issueId}/resolution`)
      .set(auth(volunteerToken))
      .send({ note: 'Cleared it' })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  const verify = () =>
    request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.VERIFIED })
      .expect(200);

  const reverse = () =>
    request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.IN_PROGRESS, reason: 'Still blocked' })
      .expect(200);

  it('starts at zero', async () => {
    const res = await points().expect(200);

    expect(res.body.balance).toBe(0);
    expect(res.body.transactions).toHaveLength(0);
  });

  it('awards ten on verification, and reflects it on the user', async () => {
    await verify();

    const res = await points().expect(200);
    expect(res.body.balance).toBe(10);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].reason).toBe(
      PointsReason.RESOLUTION_VERIFIED,
    );

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set(auth(volunteerToken))
      .expect(200);
    expect(me.body.civicPointsCached).toBe(10);
  });

  // The record of an award and its undoing is what a volunteer needs when
  // their balance drops.
  it('reverses to zero, leaving two rows rather than erasing one', async () => {
    await verify();
    await reverse();

    const res = await points().expect(200);
    expect(res.body.balance).toBe(0);
    expect(res.body.transactions).toHaveLength(2);
    expect(
      res.body.transactions.map((t: { amount: number }) => t.amount).sort(),
    ).toEqual([-10, 10]);
  });

  it('pays once for a verify cycle', async () => {
    await verify();
    await reverse();

    await request(app.getHttpServer())
      .post(`/issues/${issueId}/resolution`)
      .set(auth(volunteerToken))
      .send({ note: 'Fixed properly this time' })
      .expect(200);
    await verify();

    const res = await points().expect(200);
    expect(res.body.balance).toBe(10);
    expect(res.body.transactions).toHaveLength(3);
  });

  it('leaves reputation alone', async () => {
    await verify();

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set(auth(volunteerToken))
      .expect(200);

    expect(me.body.reputation).toBe(100);
  });

  it('refuses an anonymous balance request', async () => {
    await request(app.getHttpServer()).get('/users/me/points').expect(401);
  });

  // A volunteer who also holds AGENCY cannot approve their own work merely by
  // having the role the route checks. This changes the volunteer's roles for
  // the rest of the run, so it runs last.
  it('refuses a volunteer who also holds AGENCY from verifying their own resolved issue', async () => {
    await connection
      .collection('users')
      .updateOne(
        { email: 'v@x.test' },
        { $set: { roles: [Role.CITIZEN, Role.AGENCY] } },
      );
    const dualRoleToken = await login('v@x.test');

    await request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(dualRoleToken))
      .send({ status: IssueStatus.VERIFIED })
      .expect(403);

    const res = await points().expect(200);
    expect(res.body.balance).toBe(0);
  });
});
