import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import {
  IssueCategory,
  IssueStatus,
  MediaPurpose,
  Role,
} from './../src/contracts/index.js';

const PASSWORD = 'super-secret';
const PIXEL = readFileSync(join(import.meta.dirname, 'fixtures/pixel.png'));

const ISSUE = {
  title: 'Collapsed culvert',
  description: 'Gave way after Sunday rain.',
  category: IssueCategory.DRAINAGE,
  location: 'School road',
};

describe('Issue claim & resolution (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let reporterToken: string;
  let volunteerToken: string;
  let otherToken: string;
  let agencyToken: string;
  let issueId: string;

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const attachProof = (token: string) =>
    request(app.getHttpServer())
      .post(`/issues/${issueId}/media`)
      .set(auth(token))
      .attach('file', PIXEL, {
        filename: 'after.png',
        contentType: 'image/png',
      });

  const claimBy = (token: string) =>
    request(app.getHttpServer())
      .post(`/issues/${issueId}/claim`)
      .set(auth(token));

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
      'reporter@x.test',
      'volunteer@x.test',
      'other@x.test',
      'agency@x.test',
    ]) {
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

    reporterToken = await login('reporter@x.test');
    volunteerToken = await login('volunteer@x.test');
    otherToken = await login('other@x.test');
    agencyToken = await login('agency@x.test');
  });

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
    await connection.collection('issue_media.files').deleteMany({});
    await connection.collection('issue_media.chunks').deleteMany({});

    const { body } = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send(ISSUE)
      .expect(201);
    issueId = body.id;

    // A fresh issue is UNCLASSIFIED, and only UNRESTRICTED is claimable (a
    // later slice). This suite is about claim/resolve mechanics, not
    // classification, so the agency clears it by hand rather than this file
    // exercising the AI path.
    await request(app.getHttpServer())
      .patch(`/issues/${issueId}/hazard`)
      .set(auth(agencyToken))
      .send({ level: 'UNRESTRICTED', reason: 'Classified for this suite' })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs the whole arc: claim, start, prove, resolve, verify', async () => {
    const claimed = await claimBy(volunteerToken).expect(200);
    expect(claimed.body.status).toBe(IssueStatus.CLAIMED);
    expect(claimed.body.volunteer.id).toEqual(expect.any(String));
    // The name travels with the id; the reporter stays a bare id, because this
    // payload is served to anyone without a token.
    expect(claimed.body.volunteer.name).toBe('Test User');
    expect(claimed.body.reportedBy).toEqual(expect.any(String));
    expect(JSON.stringify(claimed.body)).not.toContain('reporterName');

    await request(app.getHttpServer())
      .post(`/issues/${issueId}/start`)
      .set(auth(volunteerToken))
      .expect(200)
      .expect((res) => expect(res.body.status).toBe(IssueStatus.IN_PROGRESS));

    const proof = await attachProof(volunteerToken).expect(201);
    expect(proof.body.purpose).toBe(MediaPurpose.PROOF);

    const resolved = await request(app.getHttpServer())
      .post(`/issues/${issueId}/resolution`)
      .set(auth(volunteerToken))
      .send({ note: 'Cleared the silt and reset the grate.' })
      .expect(200);
    expect(resolved.body.status).toBe(IssueStatus.RESOLVED);
    expect(resolved.body.resolutionNote).toContain('silt');

    const verified = await request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.VERIFIED })
      .expect(200);
    expect(verified.body.status).toBe(IssueStatus.VERIFIED);
    expect(verified.body.verifiedAt).toEqual(expect.any(String));
    expect(verified.body.volunteer.id).toBe(claimed.body.volunteer.id);
  });

  describe('claiming', () => {
    it('refuses the reporter, naming the rule', async () => {
      const res = await claimBy(reporterToken).expect(403);

      expect(res.body.message).toMatch(/reported/i);
    });

    it('refuses a second claimer with 409', async () => {
      await claimBy(volunteerToken).expect(200);

      await claimBy(otherToken).expect(409);
    });

    it('refuses an anonymous claim', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .expect(401);
    });
  });

  describe('releasing', () => {
    beforeEach(async () => {
      await claimBy(volunteerToken).expect(200);
    });

    it('returns it to OPEN, clears the holder, and frees it for someone else', async () => {
      const released = await request(app.getHttpServer())
        .delete(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);

      expect(released.body.status).toBe(IssueStatus.OPEN);
      expect(released.body.volunteer).toBeUndefined();

      await claimBy(otherToken).expect(200);
    });

    it('refuses a non-holder', async () => {
      await request(app.getHttpServer())
        .delete(`/issues/${issueId}/claim`)
        .set(auth(otherToken))
        .expect(403);
    });

    it('lets an agency force-release with a reason', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.OPEN, reason: 'No progress' })
        .expect(200);

      expect(res.body.status).toBe(IssueStatus.OPEN);
      expect(res.body.volunteer).toBeUndefined();
    });

    it('refuses an agency force-release with no reason', async () => {
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.OPEN })
        .expect(400);
    });
  });

  describe('resolving', () => {
    beforeEach(async () => {
      await claimBy(volunteerToken).expect(200);
    });

    it('refuses with no proof photo', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(volunteerToken))
        .send({ note: 'Trust me' })
        .expect(400);
    });

    it('refuses with no note', async () => {
      await attachProof(volunteerToken).expect(201);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(volunteerToken))
        .send({})
        .expect(400);
    });

    it('refuses a non-holder', async () => {
      await attachProof(volunteerToken).expect(201);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(otherToken))
        .send({ note: 'Not mine' })
        .expect(403);
    });

    // Proof is read by author, so a previous volunteer's evidence does not
    // satisfy the next one's resolution.
    it('does not count proof left behind by a previous volunteer', async () => {
      await attachProof(volunteerToken).expect(201);

      await request(app.getHttpServer())
        .delete(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);

      await claimBy(otherToken).expect(200);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(otherToken))
        .send({ note: 'Someone else did this' })
        .expect(400);
    });
  });

  describe('media purpose', () => {
    it('marks the reporter photos REPORT and the holder photos PROOF', async () => {
      const reportPhoto = await request(app.getHttpServer())
        .post(`/issues/${issueId}/media`)
        .set(auth(reporterToken))
        .attach('file', PIXEL, {
          filename: 'before.png',
          contentType: 'image/png',
        })
        .expect(201);
      expect(reportPhoto.body.purpose).toBe(MediaPurpose.REPORT);

      // The outer beforeEach classifies before this photo exists, so a fresh
      // REPORT upload against a classified issue resets hazard back to
      // UNCLASSIFIED (the classifier never saw this photo) — reclassify by
      // hand again, exactly as a reporter would resubmit for classification.
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/hazard`)
        .set(auth(agencyToken))
        .send({ level: 'UNRESTRICTED', reason: 'Reclassified after the photo' })
        .expect(200);

      await claimBy(volunteerToken).expect(200);

      const proofPhoto = await attachProof(volunteerToken).expect(201);
      expect(proofPhoto.body.purpose).toBe(MediaPurpose.PROOF);
    });

    it('refuses the reporter once the issue is claimed', async () => {
      await claimBy(volunteerToken).expect(200);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/media`)
        .set(auth(reporterToken))
        .attach('file', PIXEL, { filename: 'x.png', contentType: 'image/png' })
        .expect(403);
    });
  });

  describe('the agency verdict', () => {
    beforeEach(async () => {
      await claimBy(volunteerToken).expect(200);
      await attachProof(volunteerToken).expect(201);
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(volunteerToken))
        .send({ note: 'Done' })
        .expect(200);
    });

    it('sends work back with a reason, keeping the holder', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.IN_PROGRESS, reason: 'Still blocked' })
        .expect(200);

      expect(res.body.status).toBe(IssueStatus.IN_PROGRESS);
      expect(res.body.volunteer.id).toEqual(expect.any(String));
    });

    it('refuses a citizen verifying', async () => {
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(volunteerToken))
        .send({ status: IssueStatus.VERIFIED })
        .expect(403);
    });

    it('refuses an agency setting RESOLVED directly, which would skip the evidence rule', async () => {
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.IN_PROGRESS, reason: 'back' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.RESOLVED })
        .expect(403);
    });
  });

  describe('filtering', () => {
    it('lists the issues a volunteer is working on', async () => {
      const claimed = await claimBy(volunteerToken).expect(200);

      const res = await request(app.getHttpServer())
        .get(`/issues?volunteerId=${claimed.body.volunteer.id}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(issueId);
    });
  });
});
