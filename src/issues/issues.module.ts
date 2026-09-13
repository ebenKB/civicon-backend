import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';
import { Issue, IssueSchema } from './schemas/issue.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Issue.name, schema: IssueSchema }]),
  ],
  controllers: [IssuesController],
  providers: [IssuesService],
  // Exported so later slices (claiming, points) can inject it.
  exports: [IssuesService],
})
export class IssuesModule {}
