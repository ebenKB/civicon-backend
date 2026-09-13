import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from './app.module.js';
import { PasswordService } from './auth/password.service.js';
import { Role } from './contracts/index.js';
import { User, UserDocument } from './users/schemas/user.schema.js';

/** Shared by every seeded account. Documented in the README. */
const DEMO_PASSWORD = 'Password123!';

interface SeedUser {
  name: string;
  email: string;
  roles: Role[];
  isActive?: boolean;
}

// One account per actor in the trust chain, so every role can be demonstrated
// without a registration detour.
const SAMPLE_USERS: SeedUser[] = [
  { name: 'Ama Citizen', email: 'citizen@civicon.test', roles: [Role.CITIZEN] },
  // A second citizen, not a second role. The name describes what this person
  // does, not what they are — two distinct citizens are what the
  // anti-self-dealing rule needs to be demonstrable: one reports, the other acts.
  {
    name: 'Kofi Volunteer',
    email: 'volunteer@civicon.test',
    roles: [Role.CITIZEN],
  },
  {
    name: 'Sanitation Officer',
    email: 'agency@civicon.test',
    roles: [Role.AGENCY],
  },
  {
    name: 'Akwaaba Foundation',
    email: 'sponsor@civicon.test',
    roles: [Role.SPONSOR],
  },
  { name: 'Platform Admin', email: 'admin@civicon.test', roles: [Role.ADMIN] },
  { name: 'Ada Lovelace', email: 'ada@example.com', roles: [Role.CITIZEN] },
  {
    name: 'Jane Jacobs',
    email: 'jane@example.com',
    roles: [Role.CITIZEN],
    isActive: false,
  },
];

async function seed() {
  // Nest's global logLevels filter also suppresses Logger.log from this
  // script, so the seed reports progress on stdout instead.
  const report = (message: string) => console.log(`[seed] ${message}`);

  // Standalone context: boots the DI container and the Mongoose connection
  // without starting an HTTP listener.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    // Hashed through the real service rather than embedded as literals, so a
    // change of cost factor or algorithm cannot leave stale hashes behind.
    const passwordService = app.get(PasswordService);

    // --fresh wipes the collection first; otherwise the seed upserts, so
    // re-running it is safe and won't trip the unique email index.
    if (process.argv.includes('--fresh')) {
      const { deletedCount } = await userModel.deleteMany({});
      report(`--fresh: removed ${deletedCount} existing user(s)`);
    }

    const passwordHash = await passwordService.hash(DEMO_PASSWORD);

    const result = await userModel.bulkWrite(
      SAMPLE_USERS.map((user) => ({
        updateOne: {
          filter: { email: user.email },
          update: {
            $set: {
              name: user.name,
              roles: user.roles,
              isActive: user.isActive ?? true,
              passwordHash,
            },
          },
          upsert: true,
        },
      })),
    );

    report(
      `inserted: ${result.upsertedCount}, updated: ${result.modifiedCount}`,
    );
    report(`total users in collection: ${await userModel.countDocuments()}`);
    report(`every seeded account uses the password: ${DEMO_PASSWORD}`);
  } finally {
    await app.close();
  }
}

seed().catch((error) => {
  new Logger('Seed').error(error instanceof Error ? error.message : error);
  process.exit(1);
});
