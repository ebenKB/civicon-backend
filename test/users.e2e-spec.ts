import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { Role } from './../src/contracts/index.js';

// Exercises the real MongoDB connection, so `docker compose up -d` must be
// running. See README "Running tests".
describe('UsersController (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let adminToken: string;
  let citizenToken: string;
  let citizenId: string;

  const PASSWORD = 'super-secret';

  const register = (email: string, roles?: Role[]) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Test User',
        email,
        password: PASSWORD,
        ...(roles ? { roles } : {}),
      });

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

    // Guard against clobbering a real database if MONGODB_URI is ever
    // misconfigured — vitest.config.e2e.ts is meant to force a "_test" suffix.
    if (!connection.name.endsWith('_test')) {
      throw new Error(
        `Refusing to run destructive e2e tests against database "${connection.name}" ` +
          `— expected a database ending in "_test".`,
      );
    }
  });

  beforeEach(async () => {
    await connection.collection('users').deleteMany({});

    await register('admin@example.com').expect(201);
    await connection
      .collection('users')
      .updateOne(
        { email: 'admin@example.com' },
        { $set: { roles: [Role.ADMIN] } },
      );
    adminToken = await login('admin@example.com');

    const { body } = await register('citizen@example.com').expect(201);
    citizenId = body.user.id;
    citizenToken = await login('citizen@example.com');
  });

  afterAll(async () => {
    await connection.collection('users').deleteMany({});
    await app.close();
  });

  it('no longer exposes POST /users', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Ada', email: 'ada@example.com' })
      .expect(404);
  });

  it('refuses an unauthenticated list', async () => {
    await request(app.getHttpServer()).get('/users').expect(401);
  });

  it('refuses a citizen', async () => {
    await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${citizenToken}`)
      .expect(403);
  });

  it('lists users for an admin', async () => {
    const res = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('updates a user', async () => {
    const updated = await request(app.getHttpServer())
      .patch(`/users/${citizenId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Alan Turing' })
      .expect(200);

    expect(updated.body.name).toBe('Alan Turing');
  });

  it('refuses to let PATCH /users/:id escalate roles', async () => {
    // `roles` is not on UpdateUserDto, and forbidNonWhitelisted rejects it.
    await request(app.getHttpServer())
      .patch(`/users/${citizenId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: [Role.ADMIN] })
      .expect(400);
  });

  it('grants AGENCY through the dedicated role endpoint', async () => {
    const granted = await request(app.getHttpServer())
      .patch(`/users/${citizenId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: [Role.AGENCY] })
      .expect(200);

    // Replace semantics: AGENCY implies nothing, so CITIZEN is gone.
    expect(granted.body.roles).toEqual([Role.AGENCY]);
  });

  it('applies the VOLUNTEER implication on a role grant', async () => {
    const granted = await request(app.getHttpServer())
      .patch(`/users/${citizenId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: [Role.VOLUNTEER] })
      .expect(200);

    expect(granted.body.roles).toEqual([Role.VOLUNTEER, Role.CITIZEN]);
  });

  it('rejects an empty roles array', async () => {
    await request(app.getHttpServer())
      .patch(`/users/${citizenId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: [] })
      .expect(400);
  });

  it('refuses a citizen the role-grant endpoint', async () => {
    await request(app.getHttpServer())
      .patch(`/users/${citizenId}/roles`)
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ roles: [Role.ADMIN] })
      .expect(403);
  });

  it('deletes a user', async () => {
    await request(app.getHttpServer())
      .delete(`/users/${citizenId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/users/${citizenId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  // Regression: these used to escape as opaque 500s.
  it.each([
    ['get', '/users/not-an-object-id'],
    ['patch', '/users/not-an-object-id'],
    ['delete', '/users/not-an-object-id'],
  ])('returns 400, not 500, for a malformed id (%s)', async (method, url) => {
    const res = await request(app.getHttpServer())
      [method](url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for a well-formed but unknown id', async () => {
    await request(app.getHttpServer())
      .get('/users/000000000000000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
