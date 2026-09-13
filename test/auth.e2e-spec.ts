import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { Role } from './../src/contracts/index.js';

describe('AuthController (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;

  const PASSWORD = 'super-secret';

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
  });

  afterEach(async () => {
    await connection.collection('users').deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers, logs in, and reports the caller kind at /auth/me', async () => {
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: PASSWORD,
        roles: [Role.VOLUNTEER],
      })
      .expect(201);

    expect(registered.body.token).toEqual(expect.any(String));
    expect(registered.body.user.roles).toEqual([Role.VOLUNTEER, Role.CITIZEN]);

    const loggedIn = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .expect(200);

    expect(me.body).toMatchObject({
      email: 'ada@example.com',
      roles: [Role.VOLUNTEER, Role.CITIZEN],
      civicPointsCached: 0,
      reputation: 100,
    });
  });

  it('reflects a role change without requiring a new login', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: PASSWORD })
      .expect(201);

    await connection
      .collection('users')
      .updateOne(
        { email: 'ada@example.com' },
        { $set: { roles: [Role.AGENCY] } },
      );

    // The token still carries CITIZEN; /auth/me re-reads and is authoritative.
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.token}`)
      .expect(200);

    expect(me.body.roles).toEqual([Role.AGENCY]);
  });

  it.each([Role.AGENCY, Role.SPONSOR, Role.ADMIN])(
    'refuses to let a registrant grant themselves %s',
    async (role) => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Mallory',
          email: 'mallory@example.com',
          password: PASSWORD,
          roles: [role],
        })
        .expect(400);

      const count = await connection
        .collection('users')
        .countDocuments({ email: 'mallory@example.com' });
      expect(count).toBe(0);
    },
  );

  it('rejects a duplicate email with 409', async () => {
    const payload = {
      name: 'Ada',
      email: 'ada@example.com',
      password: PASSWORD,
    };

    await request(app.getHttpServer())
      .post('/auth/register')
      .send(payload)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...payload, name: 'Ada Again' })
      .expect(409);

    expect(res.body.message).toMatch(/email/);
  });

  it('rejects a password shorter than 8 characters', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'short' })
      .expect(400);
  });

  // Unknown email, wrong password, an account with no password hash, and an
  // inactive account must be indistinguishable, so login cannot be used to
  // enumerate accounts.
  it('returns an identical 401 for every login failure mode', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: PASSWORD })
      .expect(201);

    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);

    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: 'not-the-password' })
      .expect(401);

    // A user document predating this module, with no hash at all. bcrypt
    // throws on an undefined hash, so without a guard this answers 500.
    await connection
      .collection('users')
      .updateOne(
        { email: 'ada@example.com' },
        { $unset: { passwordHash: '' } },
      );

    const noHash = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(401);

    await connection
      .collection('users')
      .updateOne(
        { email: 'ada@example.com' },
        { $set: { isActive: false, passwordHash: 'x' } },
      );

    const inactive = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(401);

    expect(unknown.body.message).toBe('Invalid credentials');
    expect(wrongPassword.body.message).toBe(unknown.body.message);
    expect(noHash.body.message).toBe(unknown.body.message);
    expect(inactive.body.message).toBe(unknown.body.message);
  });

  it('refuses /auth/me without a token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('refuses /auth/me with a forged token', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('never returns a password hash in any auth response', async () => {
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: PASSWORD })
      .expect(201);

    const loggedIn = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.token}`)
      .expect(200);

    for (const body of [registered.body, loggedIn.body, me.body]) {
      expect(JSON.stringify(body)).not.toContain('passwordHash');
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    }
  });
});
