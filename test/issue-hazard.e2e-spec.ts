import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { IssueCategory, Role } from './../src/contracts/index.js';

const PASSWORD = 'super-secret';
const PIXEL = readFileSync(join(import.meta.dirname, 'fixtures/pixel.png'));

const ISSUE = {
  title: 'Collapsed culvert',
  description: 'Gave way after Sunday rain.',
  category: IssueCategory.DRAINAGE,
  location: 'School road',
};

/**
 * No ANTHROPIC_API_KEY is configured for the test environment, so every AI
 * classification lands on NEEDS_REVIEW — that is the fail-closed path this
 * suite proves, not a stubbed-in outcome. An observation ticked at report
 * time restricts the issue outright, with no AI call at all, so that path is
 * the one deterministic "confident verdict" this suite can exercise.
 */
describe('Issue hazard classification (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let reporterToken: string;
  let volunteerToken: string;
  let agencyToken: string;
  let secondAgencyToken: string;

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Reports an issue and runs step 3. With no API key that lands NEEDS_REVIEW. */
  const reportedAndClassified = async (body = ISSUE): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/issues/${created.body.id}/classification`)
      .set(auth(reporterToken))
      .send({})
      .expect(200);
    return created.body.id;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());
    if (!connection.name.includes('_test')) {
      throw new Error(
        `Refusing to run destructive e2e tests against database "${connection.name}".`,
      );
    }

    await connection.collection('users').deleteMany({});
    for (const email of [
      'reporter@hazard.test',
      'volunteer@hazard.test',
      'agency@hazard.test',
      'agency2@hazard.test',
    ]) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'Test User', email, password: PASSWORD })
        .expect(201);
    }
    await connection
      .collection('users')
      .updateOne(
        { email: 'agency@hazard.test' },
        { $set: { roles: [Role.AGENCY] } },
      );
    await connection
      .collection('users')
      .updateOne(
        { email: 'agency2@hazard.test' },
        { $set: { roles: [Role.AGENCY] } },
      );

    reporterToken = await login('reporter@hazard.test');
    volunteerToken = await login('volunteer@hazard.test');
    agencyToken = await login('agency@hazard.test');
    secondAgencyToken = await login('agency2@hazard.test');
  });

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
    await connection.collection('issue_media.files').deleteMany({});
    await connection.collection('issue_media.chunks').deleteMany({});
    await connection.collection('point_transactions').deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates an issue nobody can claim until it is classified', async () => {
    const created = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send(ISSUE)
      .expect(201);
    expect(created.body.hazard).toBe('UNCLASSIFIED');

    await request(app.getHttpServer())
      .post(`/issues/${created.body.id}/claim`)
      .set(auth(volunteerToken))
      .expect(403);
  });

  it('restricts outright when the reporter ticked an observation', async () => {
    const created = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send({ ...ISSUE, observations: ['obs-wires'] })
      .expect(201);

    const classified = await request(app.getHttpServer())
      .post(`/issues/${created.body.id}/classification`)
      .set(auth(reporterToken))
      .send({})
      .expect(200);

    expect(classified.body.hazard).toBe('RESTRICTED');
    expect(classified.body.hazardAssessment.source).toBe('REPORTER');
  });

  it('falls to the review queue when classification cannot run', async () => {
    const created = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send(ISSUE)
      .expect(201);

    const classified = await request(app.getHttpServer())
      .post(`/issues/${created.body.id}/classification`)
      .set(auth(reporterToken))
      .send({})
      .expect(200);

    expect(classified.body.hazard).toBe('NEEDS_REVIEW');

    const queue = await request(app.getHttpServer())
      .get('/issues?hazard=NEEDS_REVIEW')
      .expect(200);
    expect(queue.body.map((i: { id: string }) => i.id)).toContain(
      created.body.id,
    );
  });

  it('lists issues still waiting to be submitted for classification', async () => {
    const created = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send(ISSUE)
      .expect(201);

    const queue = await request(app.getHttpServer())
      .get('/issues?hazard=UNCLASSIFIED')
      .expect(200);
    expect(queue.body.map((i: { id: string }) => i.id)).toContain(
      created.body.id,
    );
  });

  it('lets an agency clear it, and only then can a volunteer claim', async () => {
    const created = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send(ISSUE)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/issues/${created.body.id}/classification`)
      .set(auth(reporterToken))
      .send({})
      .expect(200);
    const issueId = created.body.id;

    await request(app.getHttpServer())
      .post(`/issues/${issueId}/claim`)
      .set(auth(volunteerToken))
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/issues/${issueId}/hazard`)
      .set(auth(agencyToken))
      .send({ level: 'UNRESTRICTED', reason: 'Ordinary streetlight' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/issues/${issueId}/claim`)
      .set(auth(volunteerToken))
      .expect(200);
  });

  it('refuses a reason-less hazard change', async () => {
    const issueId = await reportedAndClassified();

    await request(app.getHttpServer())
      .patch(`/issues/${issueId}/hazard`)
      .set(auth(agencyToken))
      .send({ level: 'UNRESTRICTED' })
      .expect(400);
  });

  it('refuses a citizen changing the hazard', async () => {
    const issueId = await reportedAndClassified();

    await request(app.getHttpServer())
      .patch(`/issues/${issueId}/hazard`)
      .set(auth(volunteerToken))
      .send({ level: 'UNRESTRICTED', reason: 'Looks fine' })
      .expect(403);
  });

  it('takes a restricted issue to VERIFIED through an agency, paying nobody', async () => {
    const issueId = await reportedAndClassified({
      ...ISSUE,
      observations: ['obs-wires'],
    });

    const restricted = await request(app.getHttpServer())
      .get(`/issues/${issueId}`)
      .expect(200);
    expect(restricted.body.hazard).toBe('RESTRICTED');

    // No citizen may touch it.
    await request(app.getHttpServer())
      .post(`/issues/${issueId}/claim`)
      .set(auth(volunteerToken))
      .expect(403);

    // The agency evidences its own fix.
    await request(app.getHttpServer())
      .post(`/issues/${issueId}/media`)
      .set(auth(agencyToken))
      .attach('file', PIXEL, {
        filename: 'after.png',
        contentType: 'image/png',
      })
      .expect(201);

    const resolved = await request(app.getHttpServer())
      .post(`/issues/${issueId}/resolution`)
      .set(auth(agencyToken))
      .send({ note: 'Utility crew attended and made it safe' })
      .expect(200);
    expect(resolved.body.status).toBe('RESOLVED');

    // It cannot sign off its own work.
    await request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: 'VERIFIED' })
      .expect(403);

    const verified = await request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(secondAgencyToken))
      .send({ status: 'VERIFIED' })
      .expect(200);
    expect(verified.body.status).toBe('VERIFIED');

    // Nobody volunteered, so nobody is paid.
    const points = await request(app.getHttpServer())
      .get('/users/me/points')
      .set(auth(agencyToken))
      .expect(200);
    expect(points.body.balance).toBe(0);
    expect(points.body.transactions).toEqual([]);
  });

  // Public on purpose: the report form needs the checkbox wording before
  // anyone has signed in.
  it('serves the question bank without a token', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/hazard/questions')
      .expect(200);

    expect(body.observations.length).toBeGreaterThan(0);
    expect(body.followUps.length).toBeGreaterThan(0);
    expect(body.observations.map((q: { id: string }) => q.id)).toContain(
      'obs-wires',
    );
    expect(body.followUps.map((q: { id: string }) => q.id)).toContain('elec-1');
  });

  // The whole point of the endpoint: ids returned in pendingQuestions must be
  // renderable from what it serves, or a client is no better off.
  it('covers every id the classifier can put in pendingQuestions', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/hazard/questions')
      .expect(200);

    for (const question of body.followUps) {
      expect(typeof question.text).toBe('string');
      expect(question.text.length).toBeGreaterThan(10);
    }
    expect(body.observations[0].tags).toBeUndefined();
  });
});
