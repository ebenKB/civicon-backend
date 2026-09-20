import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PointsModule } from '../points/points.module.js';
import { UsersModule } from '../users/users.module.js';
import { IssueHazardService } from './issue-hazard.service.js';
import { IssueLifecycleService } from './issue-lifecycle.service.js';
import { IssueMediaController } from './issue-media.controller.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssueVerificationService } from './issue-verification.service.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';
import { Issue, IssueSchema } from './schemas/issue.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Issue.name, schema: IssueSchema }]),
    PointsModule,
    UsersModule,
  ],
  controllers: [IssuesController, IssueMediaController],
  providers: [
    IssuesService,
    IssueLifecycleService,
    IssueMediaService,
    IssueVerificationService,
    IssueHazardService,
  ],
  // Exported so later slices (claiming, points) can inject it.
  exports: [
    IssuesService,
    IssueLifecycleService,
    IssueMediaService,
    IssueVerificationService,
    IssueHazardService,
  ],
})
export class IssuesModule {}
