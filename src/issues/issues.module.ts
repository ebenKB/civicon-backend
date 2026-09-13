import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IssueLifecycleService } from './issue-lifecycle.service.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';
import { Issue, IssueSchema } from './schemas/issue.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Issue.name, schema: IssueSchema }]),
  ],
  controllers: [IssuesController],
  providers: [IssuesService, IssueLifecycleService],
  // Exported so later slices (claiming, points) can inject it.
  exports: [IssuesService, IssueLifecycleService],
})
export class IssuesModule {}
