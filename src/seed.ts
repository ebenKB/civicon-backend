import { Logger } from '@nestjs/common';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Connection } from 'mongoose';
import { AppModule } from './app.module.js';
import { PasswordService } from './auth/password.service.js';
import {
  IssueCategory,
  IssueStatus,
  MEDIA_BUCKET,
  Role,
} from './contracts/index.js';
import { Issue, IssueDocument } from './issues/schemas/issue.schema.js';
import { IssueLifecycleService } from './issues/issue-lifecycle.service.js';
import { IssueMediaService } from './issues/issue-media.service.js';
import { loadSeedImage } from './seed-images.js';
import { User, UserDocument } from './users/schemas/user.schema.js';

/**
 * Demo photographs, one per issue, named `<image>-before.<ext>` (and
 * `<image>-after.<ext>` for the proof a volunteer uploads live in the demo).
 * Resolved from the compiled file, so it is the repo's seed/images whichever
 * directory the seed is run from.
 */
const SEED_IMAGES = fileURLToPath(new URL('../seed/images/', import.meta.url));

/**
 * A 1x1 PNG, inlined so the seed runs before any demo photograph exists. Used
 * for an issue whose image has not been generated yet, so every issue still
 * carries a photo and the media endpoints have something to serve.
 */
const SAMPLE_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

interface SeedIssue {
  title: string;
  description: string;
  category: IssueCategory;
  location: string;
  /** Email of the seeded user who reported it. */
  reporterEmail: string;
  /** Base name of its photographs in seed/images. */
  image: string;
}

// All OPEN, so the claim-and-resolution slice has material to work with.
const SAMPLE_ISSUES: SeedIssue[] = [
  {
    title: 'Blocked drain floods the junction',
    description: 'Standing water after every rain; the gutter is full of silt.',
    category: IssueCategory.DRAINAGE,
    location: 'Market Street junction',
    reporterEmail: 'citizen@civicon.test',
    image: 'blocked-drain',
  },
  {
    title: 'Streetlight out for two weeks',
    description: 'The stretch by the school is dark from dusk.',
    category: IssueCategory.ELECTRICITY,
    location: 'Ring Road East, by the school',
    reporterEmail: 'citizen@civicon.test',
    image: 'streetlight-out',
  },
  {
    title: 'Pothole damaging vehicles',
    description: 'Deep pothole in the inbound lane, widening each week.',
    category: IssueCategory.ROADS,
    location: 'Independence Avenue, inbound',
    reporterEmail: 'volunteer@civicon.test',
    image: 'pothole',
  },
  {
    title: 'Refuse skip overflowing',
    description: 'Uncollected for ten days; waste is spreading onto the path.',
    category: IssueCategory.SANITATION,
    location: 'Behind the central market',
    reporterEmail: 'ada@example.com',
    image: 'overflowing-skip',
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
    const issueModel = app.get<Model<IssueDocument>>(getModelToken(Issue.name));

    if (process.argv.includes('--fresh')) {
      const { deletedCount } = await issueModel.deleteMany({});
      report(`--fresh: removed ${deletedCount} existing issue(s)`);

      // Media belongs to issues, so it goes with them. Dropping the bucket
      // collections is the only way to clear GridFS wholesale.
      const db = app.get<Connection>(getConnectionToken()).db;
      for (const name of [`${MEDIA_BUCKET}.files`, `${MEDIA_BUCKET}.chunks`]) {
        await db?.collection(name).deleteMany({});
      }
      report('--fresh: removed existing issue media');

      // The ledger belongs to issues too: a fresh issue collection with a
      // stale ledger would leave civicPointsCached disagreeing with reality.
      const pointsResult = await db
        ?.collection('point_transactions')
        .deleteMany({});
      report(
        `--fresh: removed ${pointsResult?.deletedCount ?? 0} existing point transaction(s)`,
      );
    }

    // Reporter emails resolve to ids here rather than being hard-coded, so the
    // seed stays correct however the user documents were created.
    const usersByEmail = new Map(
      (await userModel.find().select('_id email').exec()).map((user) => [
        user.email,
        user._id,
      ]),
    );

    const issueResult = await issueModel.bulkWrite(
      SAMPLE_ISSUES.map((issue) => ({
        updateOne: {
          // title + reporter is the natural key: stable across runs, so
          // re-seeding updates rather than duplicates.
          filter: {
            title: issue.title,
            reportedBy: usersByEmail.get(issue.reporterEmail),
          },
          update: {
            $set: {
              title: issue.title,
              description: issue.description,
              category: issue.category,
              location: issue.location,
              reportedBy: usersByEmail.get(issue.reporterEmail),
            },
          },
          upsert: true,
        },
      })),
    );

    report(
      `issues inserted: ${issueResult.upsertedCount}, updated: ${issueResult.modifiedCount}`,
    );
    // Every issue gets its before photo, so each card in the demo has an image
    // and the AI has something to compare a volunteer's proof against. Skipped
    // when the issue already carries one — re-running must not pile up files —
    // and when it has moved past OPEN, where the reporter can no longer attach.
    const mediaService = app.get(IssueMediaService);
    for (const sample of SAMPLE_ISSUES) {
      const [issue] = await issueModel.find({ title: sample.title }).exec();
      if (!issue) {
        continue;
      }

      const issueId = issue._id.toString();
      const already = await mediaService.listFor(issueId);
      if (already.length > 0) {
        report(`"${sample.title}" already carries ${already.length} file(s)`);
        continue;
      }
      if (issue.status !== IssueStatus.OPEN) {
        report(`"${sample.title}" is ${issue.status}; no photo attached`);
        continue;
      }

      const image = await loadSeedImage(SEED_IMAGES, `${sample.image}-before`);
      const file = image
        ? {
            originalname: image.filename,
            mimetype: image.mimetype,
            size: image.buffer.length,
            buffer: image.buffer,
          }
        : {
            originalname: 'placeholder.png',
            mimetype: 'image/png',
            size: SAMPLE_IMAGE.length,
            buffer: SAMPLE_IMAGE,
          };

      try {
        await mediaService.upload(issueId, issue.reportedBy.toString(), file);
        report(
          image
            ? `attached ${image.filename} to "${sample.title}"`
            : `no ${sample.image}-before image yet; attached a placeholder to "${sample.title}"`,
        );
      } catch (error) {
        // A generated image over the 5MB cap should name itself, not abort the
        // whole seed with an anonymous size error.
        const reason = error instanceof Error ? error.message : String(error);
        report(`could not attach ${file.originalname}: ${reason}`);
      }
    }

    // Put one issue in CLAIMED so the demo opens mid-arc rather than with
    // everything untouched. Goes through the lifecycle service rather than
    // writing status directly — that invariant holds in the seed too.
    //
    // The pothole is reported by volunteer@civicon.test, so the citizen claims
    // it: claiming your own report is refused, which is the point of the rule.
    const lifecycle = app.get(IssueLifecycleService);
    const [toClaim] = await issueModel
      .find({ title: SAMPLE_ISSUES[2].title })
      .exec();
    const claimer = usersByEmail.get('citizen@civicon.test');

    if (toClaim && claimer && toClaim.status === IssueStatus.OPEN) {
      await lifecycle.claim(toClaim._id.toString(), claimer.toString());
      report(`claimed "${toClaim.title}" for citizen@civicon.test`);
    }

    report(`every seeded account uses the password: ${DEMO_PASSWORD}`);
  } finally {
    await app.close();
  }
}

seed().catch((error) => {
  new Logger('Seed').error(error instanceof Error ? error.message : error);
  process.exit(1);
});
