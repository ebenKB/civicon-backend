import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

// Exercises the real MongoDB connection, so `docker compose up -d` must be
// running. See README "Running tests".
describe('UsersController (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // The ValidationPipe and MongoExceptionFilter come from AppModule
    // (APP_PIPE / APP_FILTER), so this app matches production exactly.
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

    await connection.collection('users').deleteMany({});
  });

  afterEach(async () => {
    await connection.collection('users').deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates and reads back a user', async () => {
    const created = await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'Ada Lovelace', email: 'ada@example.com' })
      .expect(201);

    expect(created.body).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      isActive: true,
    });
    expect(created.body.id).toBeDefined();

    const fetched = await request(app.getHttpServer())
      .get(`/users/${created.body.id}`)
      .expect(200);

    expect(fetched.body.email).toBe('ada@example.com');
  });

  it('lists users', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'Grace Hopper', email: 'grace@example.com' })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/users').expect(200);

    expect(res.body).toHaveLength(1);
  });

  it('updates a user', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'Alan', email: 'alan@example.com' })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/users/${body.id}`)
      .send({ name: 'Alan Turing' })
      .expect(200);

    expect(updated.body.name).toBe('Alan Turing');
  });

  it('deletes a user', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'Temp', email: 'temp@example.com' })
      .expect(201);

    await request(app.getHttpServer()).delete(`/users/${body.id}`).expect(204);
    await request(app.getHttpServer()).get(`/users/${body.id}`).expect(404);
  });

  it('rejects an invalid payload', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'No Email', email: 'not-an-email' })
      .expect(400);
  });

  it('rejects unknown properties', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'X', email: 'x@example.com', role: 'admin' })
      .expect(400);
  });

  // Regression: these used to escape as opaque 500s.
  it.each([
    ['get', '/users/not-an-object-id'],
    ['patch', '/users/not-an-object-id'],
    ['delete', '/users/not-an-object-id'],
  ])('returns 400, not 500, for a malformed id (%s)', async (method, url) => {
    const res = await request(app.getHttpServer())[method](url).send({});
    expect(res.status).toBe(400);
  });

  it('returns 409, not 500, on a duplicate email', async () => {
    const payload = { name: 'Ada', email: 'ada@example.com' };

    await request(app.getHttpServer()).post('/users').send(payload).expect(201);

    const res = await request(app.getHttpServer())
      .post('/users')
      .send({ ...payload, name: 'Ada Again' })
      .expect(409);

    expect(res.body.message).toMatch(/email/);
  });

  it('returns 404 for a well-formed but unknown id', async () => {
    await request(app.getHttpServer())
      .get('/users/000000000000000000000000')
      .expect(404);
  });
});
