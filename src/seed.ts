import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from './app.module.js';
import { User, UserDocument } from './users/schemas/user.schema.js';

const SAMPLE_USERS: Array<Partial<User>> = [
  { name: 'Ada Lovelace', email: 'ada@example.com', isActive: true },
  { name: 'Grace Hopper', email: 'grace@example.com', isActive: true },
  { name: 'Alan Turing', email: 'alan@example.com', isActive: true },
  { name: 'Katherine Johnson', email: 'katherine@example.com', isActive: true },
  { name: 'Jane Jacobs', email: 'jane@example.com', isActive: false },
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

    // --fresh wipes the collection first; otherwise the seed upserts, so
    // re-running it is safe and won't trip the unique email index.
    if (process.argv.includes('--fresh')) {
      const { deletedCount } = await userModel.deleteMany({});
      report(`--fresh: removed ${deletedCount} existing user(s)`);
    }

    const result = await userModel.bulkWrite(
      SAMPLE_USERS.map((user) => ({
        updateOne: {
          filter: { email: user.email },
          update: { $set: user },
          upsert: true,
        },
      })),
    );

    report(
      `inserted: ${result.upsertedCount}, updated: ${result.modifiedCount}`,
    );
    report(`total users in collection: ${await userModel.countDocuments()}`);
  } finally {
    await app.close();
  }
}

seed().catch((error) => {
  new Logger('Seed').error(error instanceof Error ? error.message : error);
  process.exit(1);
});
